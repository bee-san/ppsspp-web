/**
 * MiningSessionService — sentence mining lifecycle.
 *
 * Owns: settings persistence, the audio/frame rolling buffers, continuous frame
 * capture, the hotkey + Mine button entry points, the picker state, encoding
 * (MP3 worker + animated WebP mux) and the AnkiConnect hand-off. The emulator is
 * only touched through the reading bridge (v2).
 */
import { Injectable, signal } from '@angular/core';
import type { LifecycleEvent } from '../ocr/ocr-types';
import { AnkiConnect, AnkiConnectError, blobToBase64, mediaFilename } from './anki-connect';
import { AudioRingBuffer, subSlice } from './audio-ring-buffer';
import { FrameRingBuffer } from './frame-ring-buffer';
import { MiningFrameCapture } from './mining-frame-capture';
import { defaultRange } from './mining-picker-math';
import { MiningRuntimeBridge } from './mining-runtime-bridge';
import { hotkeyMatches, loadMiningSettings, resetMiningSettings, sanitizeMiningSettings, saveMiningSettings } from './mining-settings';
import { emptyMiningDiagnostics, type EncodedClip, type MiningDiagnostics, type MiningSelection, type MiningSettings, type MiningSnapshot } from './mining-types';
import { Mp3EncoderClient } from './mp3-encoder';
import { muxTimedFrames } from './webp-animation-muxer';

export type PickerPhase = 'select' | 'encoding' | 'sending' | 'done' | 'error';

export interface PickerState {
  snapshot: MiningSnapshot;
  /** Initial selection proposed to the picker. */
  initial: MiningSelection;
  phase: PickerPhase;
  progress: number;
  message: string;
  /** Last encoded clip (kept for the "Download instead" fallback). */
  encoded: EncodedClip | null;
}

const DEBUG_KEY = 'ppsspp_mining_debug';

@Injectable({ providedIn: 'root' })
export class MiningSessionService {
  readonly settings = signal<MiningSettings>(loadMiningSettings(localStorage));
  readonly diagnostics = signal<MiningDiagnostics>(emptyMiningDiagnostics());
  /** Non-null while the picker modal is open. */
  readonly picker = signal<PickerState | null>(null);
  /** True while the rolling buffers are being filled (drives the Mine button state). */
  readonly buffering = signal(false);
  readonly gameId = signal<string | null>(null);
  readonly debug = signal(localStorage.getItem(DEBUG_KEY) === '1');

  private bridge: MiningRuntimeBridge | null = null;
  private audio: AudioRingBuffer | null = null;
  private frames: FrameRingBuffer | null = null;
  private capture: MiningFrameCapture | null = null;
  private mp3: Mp3EncoderClient | null = null;
  private unsubscribers: Array<() => void> = [];
  private releaseClaim: (() => void) | null = null;
  private releaseSettingsClaim: (() => void) | null = null;
  private diagTimer: ReturnType<typeof setInterval> | null = null;
  private attached = false;
  private gameRunning = false;
  private documentVisible = true;
  private lastSelection: MiningSelection | null = null;

  // ─────────────────────────── attach ───────────────────────────

  async attach(): Promise<void> {
    if (this.attached) return;
    this.attached = true;
    const bridge = await MiningRuntimeBridge.waitFor(15_000);
    if (!bridge) {
      this.patchDiag({ phase: 'bridge-missing', message: 'Reading bridge v2 not available; sentence mining disabled.' });
      return;
    }
    this.bridge = bridge;
    const s = this.settings();
    this.audio = new AudioRingBuffer(s.bufferSeconds);
    this.frames = new FrameRingBuffer(s.bufferSeconds * 1000);
    this.capture = new MiningFrameCapture(bridge, this.frames, { fps: s.imageFps, maxWidth: s.imageMaxWidth, quality: s.imageQuality });
    this.mp3 = new Mp3EncoderClient();

    const st = bridge.getState();
    this.gameRunning = st.phase === 'running';
    this.documentVisible = st.documentVisible;
    this.gameId.set(st.gameId);

    this.unsubscribers.push(bridge.subscribe((ev) => this.onLifecycle(ev)));
    this.unsubscribers.push(bridge.onAudio((chunk) => this.audio?.push(chunk)));
    this.unsubscribers.push(bridge.onKey((e) => this.onKey(e)));
    const onBlur = () => this.pickerBlur?.();
    window.addEventListener('blur', onBlur);
    this.unsubscribers.push(() => window.removeEventListener('blur', onBlur));

    this.diagTimer = setInterval(() => this.refreshDiag(), 500);
    this.syncRunning();
  }

  /** Set by the picker component so `window.blur` can stop preview playback. */
  pickerBlur: (() => void) | null = null;

  private onLifecycle(ev: LifecycleEvent): void {
    switch (ev.type) {
      case 'phase':
        this.gameRunning = ev.phase === 'running';
        if (!this.gameRunning) {
          // A restart makes the old buffers meaningless (and the picker, if open).
          this.audio?.clear();
          this.frames?.clear();
        }
        this.syncRunning();
        break;
      case 'game-changed':
        this.gameId.set(ev.gameId);
        break;
      case 'visibility':
        this.documentVisible = ev.visible;
        this.syncRunning();
        break;
      case 'context-lost':
        this.frames?.clear();
        break;
      default:
        break;
    }
  }

  /** Start/stop buffering according to enabled × running × visible. */
  private syncRunning(): void {
    const s = this.settings();
    const want = s.enabled && this.gameRunning && this.documentVisible && !!this.bridge;
    if (want) {
      this.capture?.start();
      this.buffering.set(true);
      if (this.diagnostics().phase === 'off' || this.diagnostics().phase === 'idle') this.patchDiag({ phase: 'buffering', message: 'Buffering game audio and frames' });
    } else {
      this.capture?.stop();
      this.buffering.set(false);
      if (!s.enabled) this.patchDiag({ phase: 'off', message: 'Sentence mining is off' });
      else if (!this.gameRunning) this.patchDiag({ phase: 'idle', message: 'Waiting for the game to run' });
      else this.patchDiag({ phase: 'idle', message: 'Paused while the tab is hidden' });
    }
  }

  private refreshDiag(): void {
    const a = this.audio;
    const f = this.frames;
    this.diagnostics.update((d) => ({
      ...d,
      bufferedAudioMs: a?.availableMs() ?? 0,
      sampleRate: a?.rate ?? 0,
      channelCount: a?.channelsCount ?? 0,
      frameCount: f?.length ?? 0,
      frameBytes: f?.byteLength ?? 0,
    }));
  }

  // ─────────────────────────── settings ───────────────────────────

  update(patch: Partial<MiningSettings>): void {
    const prev = this.settings();
    const next = sanitizeMiningSettings({ ...prev, ...patch, schemaVersion: 1 });
    this.settings.set(next);
    saveMiningSettings(localStorage, next);
    this.applySettings(prev, next);
  }

  private applySettings(prev: MiningSettings, next: MiningSettings): void {
    if (prev.bufferSeconds !== next.bufferSeconds) {
      this.audio?.reconfigure(next.bufferSeconds);
      this.frames?.setMaxAge(next.bufferSeconds * 1000);
    }
    this.capture?.setOptions({ fps: next.imageFps, maxWidth: next.imageMaxWidth, quality: next.imageQuality });
    this.syncRunning();
  }

  toggleEnabled(): void {
    this.update({ enabled: !this.settings().enabled });
  }

  resetPreferences(): void {
    resetMiningSettings(localStorage);
    const prev = this.settings();
    const fresh = loadMiningSettings(localStorage);
    this.settings.set(fresh);
    this.applySettings(prev, fresh);
  }

  setDebug(on: boolean): void {
    if (on) localStorage.setItem(DEBUG_KEY, '1');
    else localStorage.removeItem(DEBUG_KEY);
    this.debug.set(on);
  }

  /** While the Mining settings tab has focus, keep typed text away from the emulator (mirrors OCR). */
  setSettingsFocus(active: boolean): void {
    if (active && !this.releaseSettingsClaim && this.bridge) this.releaseSettingsClaim = this.bridge.claimInput('mining:settings');
    else if (!active && this.releaseSettingsClaim) {
      this.releaseSettingsClaim();
      this.releaseSettingsClaim = null;
    }
  }

  // ─────────────────────────── hotkey / mine ───────────────────────────

  private onKey(e: KeyboardEvent): void {
    if (this.hotkeyRecorder) {
      // Settings tab "press a key": delivered here (bridge hook) because the claim gate
      // stops window keydown listeners while the settings section holds focus.
      if (e.type === 'keydown') this.hotkeyRecorder(e);
      return;
    }
    if (this.picker()) {
      // The picker owns the keyboard while open (Enter = add, Esc = cancel, arrows = frame step).
      if (e.type === 'keydown') this.pickerKey?.(e);
      return;
    }
    if (e.type !== 'keydown' || e.repeat) return;
    const s = this.settings();
    if (!s.enabled) return;
    if (isTextEntry(document.activeElement)) return;
    if (!hotkeyMatches(s.hotkey, e)) return;
    e.preventDefault();
    void this.mine();
  }

  /** Set by the picker component; receives keydown events delivered through the bridge hook. */
  pickerKey: ((e: KeyboardEvent) => void) | null = null;
  /** Set by the settings component while recording a hotkey; receives keydown via the bridge hook. */
  hotkeyRecorder: ((e: KeyboardEvent) => void) | null = null;

  /** True when there is something to mine right now. */
  canMine(): boolean {
    return !!this.bridge && !!this.audio && this.audio.available() > 0 && !this.picker();
  }

  /** Entry point for the hotkey and the header button. */
  async mine(): Promise<void> {
    if (!this.bridge || !this.audio || !this.frames) {
      this.toast('Sentence mining is not available (bridge missing)');
      return;
    }
    if (this.picker()) return;
    const s = this.settings();
    const nowMs = performance.now();
    const all = this.audio.sliceAll();
    if (!all || all.durationMs < 200) {
      this.toast('Nothing buffered yet — start a game first');
      return;
    }
    const audioStartMs = all.startMs;
    const audioEndMs = all.startMs + all.durationMs;
    const snapshot: MiningSnapshot = {
      nowMs,
      audioStartMs,
      audio: all,
      frames: this.frames.slice(audioStartMs - 1000, audioEndMs + 1000),
      gameId: this.gameId(),
    };
    const initial = defaultRange(audioStartMs, audioEndMs, s.defaultClipSeconds * 1000);
    if (!s.showPicker) {
      const sel: MiningSelection = s.imageMode === 'screenshot' ? { ...initial, frameAtMs: (initial.fromMs + initial.toMs) / 2 } : initial;
      this.picker.set({ snapshot, initial: sel, phase: 'encoding', progress: 0, message: 'Encoding…', encoded: null });
      await this.confirm(sel, { closeOnSuccess: true });
      return;
    }
    this.releaseClaim?.();
    this.releaseClaim = this.bridge.claimInput('mining:picker');
    this.picker.set({ snapshot, initial, phase: 'select', progress: 0, message: '', encoded: null });
    this.patchDiag({ phase: 'picking', message: 'Picker open' });
  }

  /** Called by the picker: close without adding. */
  cancel(): void {
    this.closePicker();
    this.patchDiag({ phase: this.buffering() ? 'buffering' : 'idle', message: this.buffering() ? 'Buffering game audio and frames' : 'Idle' });
  }

  private closePicker(): void {
    this.releaseClaim?.();
    this.releaseClaim = null;
    this.picker.set(null);
  }

  private patchPicker(p: Partial<PickerState>): void {
    const cur = this.picker();
    if (cur) this.picker.set({ ...cur, ...p });
  }

  /** Called by the picker on Add: encode, then send to Anki (or download when Anki fails). */
  async confirm(sel: MiningSelection, opts: { closeOnSuccess?: boolean } = {}): Promise<void> {
    const st = this.picker();
    if (!st) return;
    this.lastSelection = sel;
    let encoded: EncodedClip;
    try {
      this.patchPicker({ phase: 'encoding', progress: 0, message: 'Encoding audio…' });
      this.patchDiag({ phase: 'encoding', message: 'Encoding' });
      encoded = await this.encode(st.snapshot, sel, (pct) => this.patchPicker({ progress: pct }));
      this.patchPicker({ encoded });
    } catch (e) {
      const msg = `Encoding failed: ${(e as Error)?.message ?? e}`;
      this.patchPicker({ phase: 'error', message: msg });
      this.patchDiag({ phase: 'error', message: msg, lastError: msg });
      return;
    }
    if (this.debug()) this.downloadClip(encoded);
    try {
      this.patchPicker({ phase: 'sending', progress: 100, message: 'Sending to Anki…' });
      this.patchDiag({ phase: 'sending', message: 'Sending to Anki' });
      const noteId = await this.sendToAnki(encoded);
      this.toast(`Added to note ${noteId} ✓`);
      this.patchPicker({ phase: 'done', message: `Added to note ${noteId}` });
      this.closePicker();
      this.patchDiag({ phase: this.buffering() ? 'buffering' : 'idle', message: `Last: note ${noteId} updated` });
    } catch (e) {
      const err = e as Error;
      const hint = e instanceof AnkiConnectError && e.kind === 'permission' ? ' Approve this site in the dialog Anki shows.' : '';
      const msg = `${err?.message ?? e}${hint}`;
      this.patchPicker({ phase: 'error', message: msg });
      this.patchDiag({ phase: 'error', message: 'Anki update failed', lastError: msg });
      if (opts.closeOnSuccess && !this.settings().showPicker) {
        // Headless mode: fall back to a download so nothing is lost, then close.
        this.downloadClip(encoded);
        this.toast(`Anki failed — downloaded instead (${msg})`, 5000);
        this.closePicker();
      }
    }
  }

  /** "Download instead" from the picker's error state (or Cancel after an error). */
  downloadLast(): void {
    const enc = this.picker()?.encoded;
    if (enc) this.downloadClip(enc);
    this.closePicker();
  }

  // ─────────────────────────── encoding ───────────────────────────

  private async encode(snapshot: MiningSnapshot, sel: MiningSelection, onProgress: (pct: number) => void): Promise<EncodedClip> {
    const s = this.settings();
    const slice = subSlice(snapshot.audio, sel.fromMs, sel.toMs);
    if (slice.channels[0].length === 0) throw new Error('empty audio selection');
    const now = new Date();
    const audioFilename = mediaFilename(snapshot.gameId, 'mp3', now);
    const imageFilename = mediaFilename(snapshot.gameId, 'webp', now);

    const audioP = this.mp3!.encode(slice, s.audioBitrateKbps, onProgress);
    let image: Blob | null = null;
    if (s.imageMode === 'screenshot') {
      const at = sel.frameAtMs ?? (sel.fromMs + sel.toMs) / 2;
      const f = nearestFrame(snapshot.frames, at);
      image = f ? f.blob : null;
    } else {
      let inRange = snapshot.frames.filter((f) => f.wallTimeMs >= sel.fromMs && f.wallTimeMs <= sel.toMs);
      if (inRange.length === 0) {
        const f = nearestFrame(snapshot.frames, (sel.fromMs + sel.toMs) / 2);
        inRange = f ? [f] : [];
      }
      if (inRange.length === 1) image = inRange[0].blob;
      else if (inRange.length > 1) {
        const bytes = await Promise.all(inRange.map(async (f) => ({ bytes: new Uint8Array(await f.blob.arrayBuffer()), wallTimeMs: f.wallTimeMs })));
        const muxed = muxTimedFrames(bytes, { loopCount: 0 });
        image = new Blob([muxed], { type: 'image/webp' });
      }
    }
    const audio = await audioP;
    return { audio, image, audioFilename, imageFilename, durationMs: slice.durationMs };
  }

  // ─────────────────────────── anki ───────────────────────────

  private anki(): AnkiConnect {
    return new AnkiConnect(this.settings().ankiUrl);
  }

  private async sendToAnki(clip: EncodedClip): Promise<number> {
    const s = this.settings();
    const anki = this.anki();
    const granted = await anki.requestPermission();
    if (!granted) throw new AnkiConnectError('AnkiConnect denied access for this site.', 'permission');
    const noteId = await anki.findLatestNoteId();
    if (noteId === null) throw new AnkiConnectError('No note was added today in Anki — create the card first (e.g. with Yomitan), then mine.', 'no-note');
    const audioData = await blobToBase64(clip.audio);
    const media: Parameters<AnkiConnect['updateNoteMedia']>[1] = {
      audio: { data: audioData, filename: clip.audioFilename, fields: [s.audioField] },
    };
    if (clip.image && s.pictureField.trim()) {
      media.picture = { data: await blobToBase64(clip.image), filename: clip.imageFilename, fields: [s.pictureField] };
    }
    await anki.updateNoteMedia(noteId, media);
    if (s.tag) await anki.addTags([noteId], s.tag);
    return noteId;
  }

  /** Settings tab: request permission + version, report the outcome. */
  async testAnkiConnection(): Promise<void> {
    this.patchDiag({ anki: { ok: false, message: 'Connecting…' } });
    try {
      const anki = this.anki();
      const granted = await anki.requestPermission();
      if (!granted) {
        this.patchDiag({ anki: { ok: false, message: 'Permission denied. Click "Yes" in the dialog Anki shows, then test again.' } });
        return;
      }
      const v = await anki.version();
      const latest = await anki.findLatestNoteId();
      this.patchDiag({ anki: { ok: true, message: `Connected (AnkiConnect v${v}). ${latest ? `Latest note today: ${latest}.` : 'No note added today yet.'}` } });
    } catch (e) {
      this.patchDiag({ anki: { ok: false, message: (e as Error)?.message ?? String(e) } });
    }
  }

  // ─────────────────────────── downloads (debug / fallback) ───────────────────────────

  downloadClip(clip: EncodedClip): void {
    saveBlob(clip.audio, clip.audioFilename);
    if (clip.image) setTimeout(() => saveBlob(clip.image!, clip.imageFilename), 150);
  }

  /** Debug: download whatever is buffered right now. */
  async downloadBufferNow(): Promise<void> {
    if (!this.audio || !this.frames) return;
    const all = this.audio.sliceAll();
    if (!all) return;
    const snapshot: MiningSnapshot = { nowMs: performance.now(), audioStartMs: all.startMs, audio: all, frames: this.frames.all(), gameId: this.gameId() };
    try {
      const clip = await this.encode(snapshot, { fromMs: all.startMs, toMs: all.startMs + all.durationMs }, () => undefined);
      this.downloadClip(clip);
    } catch (e) {
      this.toast(`Debug download failed: ${(e as Error).message}`);
    }
  }

  downloadLatestFrame(): void {
    const f = this.frames?.latest();
    if (f) saveBlob(f.blob, mediaFilename(this.gameId(), 'webp'));
  }

  // ─────────────────────────── misc ───────────────────────────

  private patchDiag(p: Partial<MiningDiagnostics>): void {
    this.diagnostics.set({ ...this.diagnostics(), ...p });
  }

  toast(msg: string, ms = 3200): void {
    const w = window as unknown as { showToast?: (m: string, ms?: number) => void };
    if (typeof w.showToast === 'function') w.showToast(msg, ms);
    else console.log('[mining]', msg);
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    if (this.diagTimer) clearInterval(this.diagTimer);
    this.diagTimer = null;
    this.closePicker();
    this.setSettingsFocus(false);
    this.capture?.dispose();
    this.mp3?.dispose();
    this.attached = false;
  }
}

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

function nearestFrame<T extends { wallTimeMs: number }>(frames: readonly T[], ms: number): T | null {
  let best: T | null = null;
  let d = Infinity;
  for (const f of frames) {
    const dd = Math.abs(f.wallTimeMs - ms);
    if (dd < d) {
      d = dd;
      best = f;
    }
  }
  return best;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1000);
}
