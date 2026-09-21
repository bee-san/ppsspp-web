import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';

import { frameIndexForTime } from './frame-ring-buffer';
import { MIN_CLIP_MS, clampRange, dragHandle, formatOffset, formatSeconds, hitHandle, msToX, xToMs, type TimeRange } from './mining-picker-math';
import { MiningSessionService, type PickerState } from './mining-session.service';
import type { BufferedFrame } from './mining-types';

/**
 * SubMiner-style review step: image preview (animated range or a single frame
 * with a slider), a waveform with draggable in/out handles, preview playback,
 * Cancel / Add. Rendered inside `#miningOverlay` on top of the game canvas.
 */
@Component({
  selector: 'app-mining-picker',
  templateUrl: './mining-picker.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mining-picker-host' },
})
export class MiningPickerComponent {
  readonly mining = inject(MiningSessionService);
  private readonly destroyRef = inject(DestroyRef);
  readonly state = this.mining.picker;
  readonly settings = this.mining.settings;

  private readonly waveCanvas = viewChild<ElementRef<HTMLCanvasElement>>('wave');
  private readonly waveWrap = viewChild<ElementRef<HTMLElement>>('waveWrap');

  /** Current selection (wall-clock). */
  readonly range = signal<TimeRange>({ fromMs: 0, toMs: 0 });
  /** Screenshot mode: index into `framesInRange()`; animated mode: index of the frame currently shown. */
  readonly frameIndex = signal(0);
  readonly playing = signal(false);
  /** Playhead wall-clock ms while previewing, or null. */
  readonly playheadMs = signal<number | null>(null);

  readonly snapshot = computed(() => this.state()?.snapshot ?? null);
  readonly bounds = computed(() => {
    const s = this.snapshot();
    if (!s) return { startMs: 0, endMs: 0 };
    return { startMs: s.audioStartMs, endMs: s.audioEndMs };
  });
  readonly imageMode = computed(() => this.settings().imageMode);
  readonly framesInRange = computed<BufferedFrame[]>(() => {
    const s = this.snapshot();
    if (!s) return [];
    const r = this.range();
    const inRange = s.frames.filter((f) => f.wallTimeMs >= r.fromMs && f.wallTimeMs <= r.toMs);
    if (inRange.length > 0) return inRange;
    const i = frameIndexForTime(s.frames, (r.fromMs + r.toMs) / 2);
    return i >= 0 ? [s.frames[i]] : [];
  });
  readonly currentFrame = computed<BufferedFrame | null>(() => {
    const frames = this.framesInRange();
    if (frames.length === 0) return null;
    const i = Math.max(0, Math.min(frames.length - 1, this.frameIndex()));
    return frames[i];
  });
  readonly previewUrl = signal<string | null>(null);
  readonly durationLabel = computed(() => formatSeconds(this.range().toMs - this.range().fromMs));
  readonly fromLabel = computed(() => formatOffset(this.range().fromMs, this.bounds().endMs));
  readonly toLabel = computed(() => formatOffset(this.range().toMs, this.bounds().endMs));
  readonly busy = computed(() => {
    const p = this.state()?.phase;
    return p === 'encoding' || p === 'sending';
  });
  readonly inLeftPct = computed(() => this.pct(this.range().fromMs));
  readonly inRightPct = computed(() => 100 - this.pct(this.range().toMs));
  readonly playheadPct = computed(() => {
    const p = this.playheadMs();
    return p === null ? null : this.pct(p);
  });

  private audioCtx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playTimer = 0;
  private animTimer = 0;
  private objectUrl: string | null = null;
  private objectUrlBlob: Blob | null = null;
  private drag: { handle: 'in' | 'out' | 'both'; startX: number; start: TimeRange; pointerId: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    // Reset per opened snapshot.
    effect(() => {
      const st = this.state();
      untracked(() => this.onStateChanged(st));
    });
    // Repaint the waveform when the selection / playhead / canvas change.
    effect(() => {
      this.range();
      this.playheadMs();
      this.waveCanvas();
      this.snapshot();
      untracked(() => this.drawWave());
    });
    // Keep the preview <img> in sync with the current frame.
    effect(() => {
      const f = this.currentFrame();
      untracked(() => this.setPreviewBlob(f?.blob ?? null));
    });
    // Animated mode: cycle frames inside the range while the picker is open.
    effect(() => {
      const mode = this.imageMode();
      const frames = this.framesInRange();
      const open = !!this.state();
      untracked(() => this.syncAnimation(open && mode === 'animated' && frames.length > 1));
    });
    this.mining.pickerKey = (e) => this.onKey(e);
    this.mining.pickerBlur = () => this.stop();
    this.destroyRef.onDestroy(() => {
      this.mining.pickerKey = null;
      this.mining.pickerBlur = null;
      this.teardownAudio();
      this.syncAnimation(false);
      this.setPreviewBlob(null);
      this.resizeObserver?.disconnect();
    });
  }

  private lastSnapshot: PickerState['snapshot'] | null = null;

  private onStateChanged(st: PickerState | null): void {
    if (!st) {
      this.stop();
      this.syncAnimation(false);
      this.lastSnapshot = null;
      return;
    }
    if (st.snapshot === this.lastSnapshot) return;
    this.lastSnapshot = st.snapshot;
    this.range.set({ fromMs: st.initial.fromMs, toMs: st.initial.toMs });
    // Screenshot: default to the midpoint frame. Animated: start at the first in-range frame.
    const frames = this.framesInRange();
    this.frameIndex.set(this.imageMode() === 'screenshot' ? Math.floor(frames.length / 2) : 0);
    this.playheadMs.set(null);
    setTimeout(() => {
      this.observeResize();
      this.drawWave();
      this.focusDialog();
    }, 0);
  }

  private focusDialog(): void {
    const el = this.waveWrap()?.nativeElement.closest('.mining-picker') as HTMLElement | null;
    el?.focus?.();
  }

  private observeResize(): void {
    const wrap = this.waveWrap()?.nativeElement;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.drawWave());
    this.resizeObserver.observe(wrap);
  }

  private pct(ms: number): number {
    const b = this.bounds();
    return Math.max(0, Math.min(100, msToX(ms, 100, b.startMs, b.endMs)));
  }

  // ─────────────────────────── keyboard ───────────────────────────

  onKey(e: KeyboardEvent): void {
    const st = this.state();
    if (!st) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancel();
    } else if (e.key === 'Enter' && !this.busy()) {
      e.preventDefault();
      this.add();
    } else if (e.key === ' ' && st.phase === 'select') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (this.imageMode() === 'screenshot') {
        e.preventDefault();
        this.stepFrame(e.key === 'ArrowLeft' ? -1 : 1);
      } else {
        e.preventDefault();
        const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 250);
        this.nudge(e.altKey ? 'in' : 'out', d);
      }
    }
  }

  // ─────────────────────────── selection ───────────────────────────

  private nudge(handle: 'in' | 'out' | 'both', deltaMs: number): void {
    const b = this.bounds();
    this.range.set(dragHandle(this.range(), handle, deltaMs, b.startMs, b.endMs));
  }

  onWavePointerDown(e: PointerEvent): void {
    const wrap = this.waveWrap()?.nativeElement;
    if (!wrap || this.busy()) return;
    const rect = wrap.getBoundingClientRect();
    const b = this.bounds();
    const x = e.clientX - rect.left;
    const handle = hitHandle(x, this.range(), rect.width, b.startMs, b.endMs, 22);
    this.stop();
    if (!handle) {
      // Click outside: move the nearer edge to the click position.
      const ms = xToMs(x, rect.width, b.startMs, b.endMs);
      const r = this.range();
      const next = Math.abs(ms - r.fromMs) < Math.abs(ms - r.toMs) ? { fromMs: ms, toMs: r.toMs } : { fromMs: r.fromMs, toMs: ms };
      this.range.set(clampRange(next, b.startMs, b.endMs, MIN_CLIP_MS));
      return;
    }
    this.drag = { handle, startX: e.clientX, start: this.range(), pointerId: e.pointerId };
    wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  onWavePointerMove(e: PointerEvent): void {
    const d = this.drag;
    const wrap = this.waveWrap()?.nativeElement;
    if (!d || !wrap || e.pointerId !== d.pointerId) return;
    const rect = wrap.getBoundingClientRect();
    const b = this.bounds();
    const deltaMs = ((e.clientX - d.startX) / Math.max(1, rect.width)) * (b.endMs - b.startMs);
    this.range.set(dragHandle(d.start, d.handle, deltaMs, b.startMs, b.endMs));
  }

  onWavePointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.drag = null;
    const wrap = this.waveWrap()?.nativeElement;
    try {
      wrap?.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  // ─────────────────────────── frames ───────────────────────────

  stepFrame(delta: number): void {
    const n = this.framesInRange().length;
    if (n === 0) return;
    this.frameIndex.set(Math.max(0, Math.min(n - 1, this.frameIndex() + delta)));
  }

  onFrameSlider(ev: Event): void {
    this.frameIndex.set(Number((ev.target as HTMLInputElement).value) | 0);
  }

  private setPreviewBlob(blob: Blob | null): void {
    if (blob === this.objectUrlBlob) return;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrlBlob = blob;
    this.objectUrl = blob ? URL.createObjectURL(blob) : null;
    this.previewUrl.set(this.objectUrl);
  }

  private syncAnimation(on: boolean): void {
    if (!on) {
      if (this.animTimer) clearInterval(this.animTimer);
      this.animTimer = 0;
      return;
    }
    if (this.animTimer) return;
    const period = Math.max(40, Math.round(1000 / this.settings().imageFps));
    this.animTimer = window.setInterval(() => {
      const n = this.framesInRange().length;
      if (n <= 1) return;
      this.frameIndex.set((this.frameIndex() + 1) % n);
    }, period);
  }

  // ─────────────────────────── waveform ───────────────────────────

  private drawWave(): void {
    const canvas = this.waveCanvas()?.nativeElement;
    const wrap = this.waveWrap()?.nativeElement;
    const snap = this.snapshot();
    if (!canvas || !wrap || !snap) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(wrap.clientWidth));
    const h = Math.max(1, Math.floor(wrap.clientHeight));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bins = Math.max(16, Math.floor(w / 2));
    const b = this.bounds();
    if (this.peakCache?.bins !== bins || this.peakCache.snapshot !== snap) {
      this.peakCache = { bins, snapshot: snap, values: snap.audio.peaksByTime(b.startMs, b.endMs, bins) };
    }
    const pk = this.peakCache.values;
    const r = this.range();
    const xi = msToX(r.fromMs, w, b.startMs, b.endMs);
    const xo = msToX(r.toMs, w, b.startMs, b.endMs);
    const mid = h / 2;
    const barW = w / bins;
    for (let i = 0; i < bins; i++) {
      const x = i * barW;
      const inside = x + barW / 2 >= xi && x + barW / 2 <= xo;
      const amp = Math.max(1, pk[i] * (h * 0.92));
      ctx.fillStyle = inside ? 'rgba(0, 212, 170, 0.95)' : 'rgba(255, 255, 255, 0.22)';
      ctx.fillRect(x, mid - amp / 2, Math.max(1, barW - 1), amp);
    }
    const ph = this.playheadMs();
    if (ph !== null) {
      const x = msToX(ph, w, b.startMs, b.endMs);
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, 0, 2, h);
    }
  }

  private peakCache: { bins: number; snapshot: PickerState['snapshot']; values: Float32Array } | null = null;

  // ─────────────────────────── preview playback ───────────────────────────

  togglePlay(): void {
    if (this.playing()) this.stop();
    else void this.play();
  }

  async play(): Promise<void> {
    const snap = this.snapshot();
    if (!snap || this.busy()) return;
    this.stop();
    try {
      const ctx = (this.audioCtx ??= new AudioContext());
      if (ctx.state === 'suspended') await ctx.resume();
      const r = this.range();
      const slice = snap.audio.slice(r.fromMs, r.toMs);
      if (!slice || slice.channels[0].length === 0) return;
      const buf = ctx.createBuffer(slice.channels.length, slice.channels[0].length, slice.sampleRate);
      for (let c = 0; c < slice.channels.length; c++) buf.copyToChannel(slice.channels[c] as Float32Array<ArrayBuffer>, c);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const startedAt = ctx.currentTime;
      src.onended = () => {
        if (this.source === src) this.stop();
      };
      src.start();
      this.source = src;
      this.playing.set(true);
      const tick = () => {
        if (this.source !== src) return;
        const t = ctx.currentTime - startedAt;
        this.playheadMs.set(r.fromMs + t * 1000);
        this.playTimer = requestAnimationFrame(tick);
      };
      this.playTimer = requestAnimationFrame(tick);
    } catch (e) {
      console.warn('[mining] preview playback failed', e);
      this.stop();
    }
  }

  stop(): void {
    if (this.playTimer) cancelAnimationFrame(this.playTimer);
    this.playTimer = 0;
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* not started */
      }
      this.source.disconnect();
      this.source = null;
    }
    this.playing.set(false);
    this.playheadMs.set(null);
  }

  private teardownAudio(): void {
    this.stop();
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
  }

  // ─────────────────────────── actions ───────────────────────────

  add(): void {
    const st = this.state();
    if (!st || this.busy()) return;
    this.stop();
    const r = this.range();
    const sel = this.imageMode() === 'screenshot' ? { ...r, frameAtMs: this.currentFrame()?.wallTimeMs ?? (r.fromMs + r.toMs) / 2 } : { ...r };
    void this.mining.confirm(sel);
  }

  cancel(): void {
    this.stop();
    this.mining.cancel();
  }

  downloadInstead(): void {
    this.stop();
    this.mining.downloadLast();
  }

  retry(): void {
    this.add();
  }

  onBackdrop(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('mining-picker-backdrop') && !this.busy()) this.cancel();
  }
}
