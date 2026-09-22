/**
 * OcrSessionService — lifecycle and user settings for the reading layer.
 *
 * Owns: settings persistence, model consent + meikiocr-web client, the scan
 * controller, frame source, text layer / popup presentation, input gate and
 * region selection. The emulator is only touched through the reading bridge.
 */
import { inject, Injectable, signal } from '@angular/core';
import { createMeikiOcr, type AssetManifest, type MeikiOcrClient, type ProgressEvent } from 'meikiocr-web';
import { buildMeikiPopLayout, hitTestMeikiPop } from 'meikiocr-web/meikipop';
import type { TextHit } from 'meikiocr-web/meikipop';
import { describeMode, emptyDiagnostics, type OcrDiagnosticsSnapshot } from './ocr-diagnostics';
import { OcrFrameSource } from './ocr-frame-source';
import { OcrInputGate } from './ocr-input-gate';
import { OcrRegionSelector } from './ocr-region-selector';
import { OcrRuntimeBridge } from './ocr-runtime-bridge';
import { OcrScanController } from './ocr-scan-controller';
import { loadGamePrefs, loadSettings, resetSettings, saveGamePrefs, saveSettings, sanitize } from './ocr-settings';
import { OcrTextLayer } from './ocr-text-layer';
import { OcrTextPopup } from './ocr-text-popup';
import { FULL_REGION, type LifecycleEvent, type NormRegion, type OcrSettings, type PointerSample, type PublishedLayout } from './ocr-types';
import { clientToNorm } from './ocr-coordinate-map';
import { AgentSessionService } from '../agent/agent-session.service';
import { applyHookedText } from '../agent/hooked-text-match';

const HOTKEY_EVENT_KEYS: Record<string, string> = { shift: 'Shift', control: 'Control', alt: 'Alt', meta: 'Meta' };

@Injectable({ providedIn: 'root' })
export class OcrSessionService {
  readonly settings = signal<OcrSettings>(loadSettings(localStorage));
  readonly diagnostics = signal<OcrDiagnosticsSnapshot>(emptyDiagnostics());
  readonly modeDescription = signal<string>(describeMode(this.settings()));
  readonly regionLabel = signal<string>('Full game viewport');
  readonly gameId = signal<string | null>(null);

  private bridge: OcrRuntimeBridge | null = null;
  private host: HTMLElement | null = null;
  private stage: HTMLElement | null = null;
  private frames: OcrFrameSource | null = null;
  private controller: OcrScanController | null = null;
  private textLayer: OcrTextLayer | null = null;
  private popup: OcrTextPopup | null = null;
  private gate: OcrInputGate | null = null;
  private regionSelector: OcrRegionSelector | null = null;
  private client: MeikiOcrClient | null = null;
  private clientInit: Promise<void> | null = null;
  private clientRequest: { profile: string; backend: string; threads: number } | null = null;
  private unsubscribeLifecycle: (() => void) | null = null;
  private readonly agent = inject(AgentSessionService);
  /** Lines in the current layout whose text came from the text hook (diagnostics). */
  readonly hookCorrected = signal(0);
  private unsubscribeAgent: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private geometryTimer: number | null = null;
  private lastGeometrySig = '';
  private emulatorMenuOpen = false;
  private listeners: Array<() => void> = [];
  private lastPointer: { clientX: number; clientY: number } | null = null;
  private lastWarnings: readonly string[] = [];
  private attached = false;

  // ─────────────────────────── attach ───────────────────────────

  /** Called once the stage/overlay host exist. Safe to call before the runtime script loaded. */
  async attach(host: HTMLElement): Promise<void> {
    if (this.attached) return;
    this.attached = true;
    this.host = host;
    const bridge = await OcrRuntimeBridge.waitFor(15_000);
    if (!bridge) {
      this.patchDiag({ phase: 'bridge-missing', message: 'Reading bridge not available; OCR text disabled.' });
      return;
    }
    this.bridge = bridge;
    this.stage = bridge.getStage() ?? host.parentElement;
    this.frames = new OcrFrameSource(bridge, () => this.settings().maxCapturePixels);
    this.textLayer = new OcrTextLayer(host, { strategy: this.settings().textLayerStrategy, fontScale: this.settings().fontScale, textVisible: this.settings().overlayTextVisible });
    this.popup = new OcrTextPopup(
      host,
      { positionMode: this.settings().popupPositionMode, fontScale: this.settings().fontScale, holdMs: 350 },
      { onInteractionChange: (active) => this.gate?.set('popup', active) },
    );
    this.gate = new OcrInputGate(bridge, (n) => (this.textLayer?.contains(n) ?? false) || (this.popup?.contains(n) ?? false));
    this.gate.attach();
    this.regionSelector = new OcrRegionSelector(host, () => this.frames?.getViewport() ?? null, (fn) => bridge.onKey(fn));

    this.controller = new OcrScanController(
      {
        capture: (region) => this.frames!.capture(region),
        probe: (region) => this.frames!.probe(region),
        ocr: async (captured) => {
          if (!this.client) throw new Error('OCR client not ready');
          // Local, opt-in debugging (plan §14E: recognition logs stay local and opt-in):
          // localStorage.ppsspp_ocr_debug = "1" exposes the last capture + snapshot on window.
          const debug = localStorage.getItem('ppsspp_ocr_debug') === '1';
          const dbgCapture = debug ? { width: captured.frame.width, height: captured.frame.height, rgba: captured.frame.rgba.slice(0), meta: captured.meta } : null;
          const snapshot = await this.client.scan(captured.frame, { transfer: 'move' });
          if (debug) (window as unknown as { __ppssppOcrDebug?: unknown }).__ppssppOcrDebug = { capture: dbgCapture, snapshot };
          return snapshot;
        },
        buildLayout: (snapshot) => {
          this.lastWarnings = snapshot.diagnostics.warnings;
          return buildMeikiPopLayout(snapshot);
        },
        // Text hook (Agent script / WebSocket hooker): swap recognized line text for the exact
        // hooked string, keeping OCR's boxes — the extension then scans the game's real text.
        postProcess: (snapshot) => {
          const a = this.agent.settings();
          if (!a.enabled || a.ocrMode === 'off') return { snapshot, hookedLineIds: [] };
          const hooked = this.agent.lines().map((l) => l.text);
          const r = applyHookedText(snapshot, hooked, { threshold: a.matchThreshold, mode: a.ocrMode });
          this.hookCorrected.set(r.corrected.length);
          return { snapshot: r.snapshot, hookedLineIds: r.corrected };
        },
        hitTest: (layout, pt) => hitTestMeikiPop(layout, pt),
        sourceSize: () => {
          const vp = this.frames!.getViewport();
          return vp ? { width: vp.sourceWidth, height: vp.sourceHeight } : { width: 1, height: 1 };
        },
        onLayout: (p) => this.onLayout(p),
        onHit: (hit, pointer, published) => this.onHit(hit, pointer, published),
        onActivationChange: () => this.refreshVisibility(),
        onDiagnostics: (d) => {
          this.patchDiag({ controller: d, frames: { ...this.frames!.diag }, paragraphs: this.controller?.getPublished()?.layout.paragraphs.length ?? 0, lastOcrWarnings: this.lastWarnings });
          if (localStorage.getItem('ppsspp_ocr_debug') === '1') (window as unknown as { __ppssppOcrDiag?: unknown }).__ppssppOcrDiag = { controller: d, frames: this.frames!.diag /* live */ };
        },
        onError: (err, ctx) => this.patchDiag({ lastError: `${ctx}: ${(err as Error)?.message ?? err}` }),
      },
      this.settings(),
    );

    this.unsubscribeLifecycle = bridge.subscribe((ev) => this.onLifecycle(ev));
    const st = bridge.getState();
    this.controller.setDocumentVisible(st.documentVisible);
    this.controller.setGameReady(st.phase === 'running');
    this.gameId.set(st.gameId);
    this.applyGamePrefs(st.gameId);

    this.installDomListeners();
    // A hooked line that arrives after the frame was recognized still corrects the layout.
    this.unsubscribeAgent = this.agent.onLine(() => {
      const a = this.agent.settings();
      if (a.enabled && a.ocrMode !== 'off') this.controller?.reprocess();
    });
    this.syncGeometry();
    this.applySettingsToRuntime(this.settings());
    if (this.settings().enabled) void this.ensureModels();
    else this.patchDiag({ phase: 'off', message: 'OCR text is off' });
  }

  private installDomListeners(): void {
    const stage = this.stage;
    const canvas = this.bridge?.getCanvas();
    if (!stage) return;
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type as string, fn as EventListener, opts);
      this.listeners.push(() => el.removeEventListener(type as string, fn as EventListener, opts));
    };
    on(stage, 'pointermove', (e: PointerEvent) => this.onPointerMove(e), { passive: true });
    on(stage, 'pointerdown', (e: PointerEvent) => {
      // A tap has no hover: use it as the pointer sample (hit-test / popup / manual-mode scan).
      if (e.pointerType === 'touch') this.onPointerMove(e);
      if (!this.emulatorMenuOpen) return;
      // Any click inside PPSSPP's pause menu leaves the pause screen (Continue, Settings,
      // Exit to menu…); give the emulator a moment to redraw, then resume recognition.
      window.setTimeout(() => this.setEmulatorMenu(false), 700);
    }, { passive: true });
    on(stage, 'pointerleave', () => {
      this.lastPointer = null;
      this.controller?.pointerLeave();
      this.popup?.noHit(null);
    });
    // Hotkey via the bridge's reading-key hook: delivered before the emulator and
    // even while a reading input claim blocks keydown for the game.
    this.listeners.push(this.bridge!.onKey((e: KeyboardEvent) => this.onKey(e, e.type === 'keydown')));
    on(window, 'blur', () => this.controller?.hotkeyUp());
    on(window, 'resize', () => this.syncGeometry(), { passive: true });
    on(window, 'scroll', () => this.syncGeometry(), { passive: true });
    if (canvas && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.syncGeometry());
      this.resizeObserver.observe(canvas);
      this.resizeObserver.observe(stage);
      if (this.host) this.resizeObserver.observe(this.host);
    }
    if (canvas && typeof MutationObserver !== 'undefined') {
      // Backing-store size changes (SDL) do not change the CSS box → no ResizeObserver event.
      this.mutationObserver = new MutationObserver(() => this.syncGeometry());
      this.mutationObserver.observe(canvas, { attributes: true, attributeFilter: ['width', 'height', 'style', 'class'] });
    }
    on(stage, 'transitionend', () => this.syncGeometry(), { passive: true });
    // Watchdog: anything that moves the canvas without resizing it (transforms, layout
    // shifts elsewhere on the page, panel/header animations) is caught within one tick.
    this.geometryTimer = window.setInterval(() => this.syncGeometryIfMoved(), 250);
    this.listeners.push(() => { if (this.geometryTimer != null) { clearInterval(this.geometryTimer); this.geometryTimer = null; } });
  }

  // ─────────────────────────── events ───────────────────────────

  private onLifecycle(ev: LifecycleEvent): void {
    const c = this.controller;
    if (!c) return;
    switch (ev.type) {
      case 'phase':
        c.setGameReady(ev.phase === 'running');
        if (ev.phase !== 'running') c.invalidate(`phase:${ev.phase}`);
        this.patchDiag({ message: ev.phase === 'running' ? this.diagnostics().message : 'Waiting for the game to run' });
        break;
      case 'game-changed':
        this.gameId.set(ev.gameId);
        this.applyGamePrefs(ev.gameId);
        c.invalidate('game-changed');
        break;
      case 'scene-epoch':
        c.invalidate(`scene:${ev.reason}`);
        break;
      case 'context-lost':
        c.invalidate('context-lost');
        break;
      case 'fullscreen':
        this.patchDiag({ fullscreen: ev.active });
        // Layout changes; re-measure after the browser applies fullscreen styles.
        setTimeout(() => this.syncGeometry(), 0);
        setTimeout(() => this.syncGeometry(), 200);
        break;
      case 'visibility':
        c.setDocumentVisible(ev.visible);
        break;
      case 'geometry':
        this.syncGeometry();
        break;
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.controller || !this.frames) return;
    // Pointer inside the popup card is an interaction, not a source hover.
    if (this.popup?.contains(e.target as Node)) return;
    const vp = this.frames.getViewport();
    const norm = vp ? clientToNorm(e.clientX, e.clientY, vp.contentRect) : null;
    this.lastPointer = { clientX: e.clientX, clientY: e.clientY };
    const sample: PointerSample = { clientX: e.clientX, clientY: e.clientY, norm };
    this.controller.pointerMove(sample);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const s = this.settings();
    if (!s.enabled) return;
    // Escape toggles PPSSPP's pause menu (drawn over a dimmed game). Track it so the
    // layer hides instead of showing fragments of the dimmed text under the menu.
    if (e.key === 'Escape' && down && !e.repeat && this.bridge?.getState().phase === 'running') {
      this.setEmulatorMenu(!this.emulatorMenuOpen);
      return;
    }
    if (s.hotkey === 'none') return;
    if (e.key !== HOTKEY_EVENT_KEYS[s.hotkey]) return;
    if (down) {
      if (e.repeat) return; // rising edge only
      this.controller?.hotkeyDownEdge();
    } else {
      this.controller?.hotkeyUp();
    }
  }

  /** PPSSPP pause menu open/closed (best effort: Escape toggles it; a click inside it — Continue, Exit… — changes the screen and leaves it). */
  private setEmulatorMenu(open: boolean): void {
    if (this.emulatorMenuOpen === open) return;
    this.emulatorMenuOpen = open;
    this.controller?.setEmulatorUiOpen(open);
    this.patchDiag({ emulatorMenu: open, message: open ? 'Emulator menu open — text hidden' : this.diagnostics().message });
  }

  private onLayout(p: PublishedLayout | null): void {
    const s = this.settings();
    // The canvas backing store can change without a CSS resize (SDL resizes it when a game
    // starts; ResizeObserver stays silent), so re-measure right before placing text.
    this.syncGeometry();
    // Text hook auto-discovery correlates what is on screen with the game's memory.
    if (p && !p.stale) this.agent.observeScreenText((p.rawSnapshot ?? p.snapshot).lines.map((l) => l.text));
    if (s.presentation === 'source-aligned') this.textLayer?.setLayout(p);
    else this.textLayer?.setLayout(null);
    // Any change of the published source (cleared OR replaced) labels a pinned card as outdated.
    this.popup?.markSourceChanged();
    this.patchDiag({ paragraphs: p?.layout.paragraphs.length ?? 0, lastOcrWarnings: this.lastWarnings });
  }

  private onHit(hit: TextHit | null, pointer: PointerSample | null, published: PublishedLayout | null): void {
    const s = this.settings();
    if (s.presentation === 'source-aligned') {
      this.textLayer?.setHit(hit);
      return;
    }
    if (!this.popup || !this.stage) return;
    if (hit && pointer) {
      const r = this.stage.getBoundingClientRect();
      const conf = published ? confidenceNote(published, hit) : undefined;
      this.popup.showHit(hit, pointer, { left: r.left, top: r.top, width: r.width, height: r.height }, conf);
    } else {
      this.popup.noHit(pointer ? { clientX: pointer.clientX, clientY: pointer.clientY } : null);
    }
  }

  private syncGeometry(): void {
    if (!this.frames || !this.host || !this.textLayer) return;
    const vp = this.frames.getViewport();
    const hr = this.host.getBoundingClientRect();
    this.lastGeometrySig = geometrySig(vp, hr);
    this.textLayer.setGeometry(vp, { left: hr.left, top: hr.top, width: hr.width, height: hr.height });
    this.controller?.geometryChanged(vp?.sourceWidth, vp?.sourceHeight);
  }

  /** Cheap periodic check (two rect reads); only re-lays out when something actually moved. */
  private syncGeometryIfMoved(): void {
    if (!this.frames || !this.host || !this.textLayer || !this.settings().enabled) return;
    const vp = this.frames.getViewport();
    const hr = this.host.getBoundingClientRect();
    if (geometrySig(vp, hr) !== this.lastGeometrySig) this.syncGeometry();
  }

  private refreshVisibility(): void {
    const c = this.controller;
    const active = !!c && c.activationAllowed();
    this.textLayer?.setVisible(active);
    if (!active) this.popup?.noHit(null);
  }

  // ─────────────────────────── settings ───────────────────────────

  update(patch: Partial<OcrSettings>): void {
    const next = sanitize({ ...this.settings(), ...patch, schemaVersion: 3 });
    this.settings.set(next);
    saveSettings(localStorage, next);
    this.modeDescription.set(describeMode(next));
    this.applySettingsToRuntime(next);
  }

  private applySettingsToRuntime(s: OcrSettings): void {
    this.controller?.setSettings(s);
    this.controller?.setEnabled(s.enabled && s.modelDownloadConsent);
    this.textLayer?.setOptions({ strategy: s.textLayerStrategy, fontScale: s.fontScale, textVisible: s.overlayTextVisible });
    this.popup?.setOptions({ positionMode: s.popupPositionMode, fontScale: s.fontScale, holdMs: 350 });
    // One scannable presentation at a time; nothing when OCR is off.
    const enabled = s.enabled && s.modelDownloadConsent;
    if (!enabled || s.presentation === 'popup') this.textLayer?.setLayout(null);
    else {
      this.popup?.close();
      this.textLayer?.setLayout(this.controller?.getPublished() ?? null);
    }
    if (!enabled) this.popup?.close();
    this.refreshVisibility();
    // Profile/backend/thread changes need a new client (old results become ineligible via
    // the controller's model generation). Compare against what was *requested* at creation,
    // not the effective backend, so a WebGPU→WASM fallback does not re-create on every cosmetic edit.
    const req = this.clientRequest;
    if (this.client && req && (req.profile !== s.ocrProfile || req.backend !== s.ocrBackend || req.threads !== s.wasmThreads)) {
      void this.recreateClient();
    }
  }

  /**
   * One click, no further prompts (MeikiPop-like): enabling OCR is the confirmation for
   * the one-time ~46 MB model download, which is announced with a toast and the panel's
   * progress line. Everything runs locally; nothing leaves the page.
   */
  toggleEnabled(): void {
    const s = this.settings();
    if (!s.enabled) {
      const firstTime = !s.modelDownloadConsent;
      this.update({ enabled: true, modelDownloadConsent: true });
      if (firstTime && !this.client) this.toast('OCR: downloading ~46 MB of model files once (stored in this site\u2019s cache; runs locally)', 6000);
      void this.ensureModels();
    } else {
      this.update({ enabled: false });
      this.controller?.setModelsReady(false);
      this.patchDiag({ phase: 'off', message: 'OCR text is off' });
    }
  }

  /** Kept for callers/tests that still confirm explicitly; equivalent to the first enable. */
  grantConsent(): void {
    this.update({ enabled: true, modelDownloadConsent: true });
    void this.ensureModels();
  }

  declineConsent(): void {
    this.update({ enabled: false });
    this.patchDiag({ phase: 'off', message: 'OCR text is off' });
  }

  private toast(msg: string, ms?: number): void {
    const w = window as unknown as { showToast?: (m: string, ms?: number) => void };
    if (typeof w.showToast === 'function') w.showToast(msg, ms);
  }

  async selectRegion(): Promise<void> {
    if (!this.regionSelector) return;
    this.gate?.set('selection', true);
    try {
      const r = await this.regionSelector.select();
      if (r) this.setRegion(r);
    } finally {
      this.gate?.set('selection', false);
    }
  }

  resetRegion(): void {
    this.setRegion(FULL_REGION);
  }

  private setRegion(r: NormRegion): void {
    this.controller?.setRegion(r);
    this.regionLabel.set(r.w >= 0.999 && r.h >= 0.999 ? 'Full game viewport' : `${Math.round(r.w * 100)}×${Math.round(r.h * 100)}% at ${Math.round(r.x * 100)},${Math.round(r.y * 100)}`);
    saveGamePrefs(localStorage, this.gameId(), { region: r.w >= 0.999 && r.h >= 0.999 ? null : r, presentation: this.settings().presentation });
  }

  private applyGamePrefs(gameId: string | null): void {
    const prefs = loadGamePrefs(localStorage, gameId);
    const region = prefs?.region ?? FULL_REGION;
    this.controller?.setRegion(region);
    this.regionLabel.set(prefs?.region ? `${Math.round(region.w * 100)}×${Math.round(region.h * 100)}% at ${Math.round(region.x * 100)},${Math.round(region.y * 100)}` : 'Full game viewport');
  }

  refresh(): void {
    this.controller?.refresh();
  }

  setSettingsFocus(active: boolean): void {
    this.gate?.set('settings', active);
  }

  async clearModelCache(): Promise<void> {
    try {
      if (this.client) await this.client.clearCache();
      else if (typeof caches !== 'undefined') await caches.delete('meikiocr-web-assets-v1');
      this.patchDiag({ message: 'Downloaded OCR models removed. They will be fetched again when OCR is enabled.' });
    } catch (e) {
      this.patchDiag({ lastError: `clear cache: ${(e as Error).message}` });
    }
  }

  resetPreferences(): void {
    resetSettings(localStorage);
    const fresh = loadSettings(localStorage);
    this.settings.set(fresh);
    this.modeDescription.set(describeMode(fresh));
    this.applySettingsToRuntime(fresh);
    this.controller?.setModelsReady(false);
    this.applyGamePrefs(this.gameId());
    this.patchDiag({ phase: 'off', message: 'OCR preferences reset' });
  }

  // ─────────────────────────── models ───────────────────────────

  private async ensureModels(): Promise<void> {
    const s = this.settings();
    if (!s.enabled) return;
    if (!s.modelDownloadConsent) {
      // Legacy state (older stored settings): enabling is the confirmation.
      this.update({ modelDownloadConsent: true });
      return this.ensureModels();
    }
    if (this.client) {
      this.controller?.setModelsReady(true);
      this.patchDiag({ phase: 'ready', message: `Ready (${this.client.backend})` });
      return;
    }
    if (this.clientInit) return this.clientInit;
    this.clientInit = (async () => {
      try {
        const base = new URL('ocr-assets/', document.baseURI).href;
        this.patchDiag({ phase: 'fetching', message: 'Loading OCR model manifest…', progress: null });
        const res = await fetch(base + 'manifest.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error(`manifest.json HTTP ${res.status} (run ocr:export-assets)`);
        const manifest = (await res.json()) as AssetManifest;
        const client = await createMeikiOcr({
          manifest,
          assetBaseUrl: base,
          profile: s.ocrProfile,
          execution: s.ocrBackend,
          wasmThreads: s.wasmThreads,
          vertical: 'lazy',
          maxInputPixels: s.maxCapturePixels,
          // Factory (not a single instance) so the library can perform its bounded restart after a fatal worker error.
          workerFactory: () => new Worker(new URL('./ocr.worker', import.meta.url), { type: 'module', name: 'meikiocr-web' }),
          onProgress: (e) => this.onProgress(e),
        });
        this.client = client;
        this.clientRequest = { profile: s.ocrProfile, backend: s.ocrBackend, threads: s.wasmThreads };
        this.controller?.setModelSetId(client.modelSetId);
        this.controller?.setModelsReady(true);
        this.patchDiag({ phase: 'ready', message: `Ready (${client.backend})`, progress: null, backend: client.backend, modelSetId: client.modelSetId });
        if (this.settings().enabled) this.toast(`OCR ready — hover game text${this.settings().hotkey !== 'none' && !this.settings().lookupsWithoutHotkey ? ` while holding ${this.settings().hotkey}` : ''}`);
      } catch (e) {
        this.patchDiag({ phase: 'error', message: `OCR unavailable: ${(e as Error)?.message ?? e}`, lastError: String((e as Error)?.message ?? e), progress: null });
        this.controller?.setModelsReady(false);
      } finally {
        this.clientInit = null;
      }
    })();
    return this.clientInit;
  }

  private async recreateClient(): Promise<void> {
    const old = this.client;
    this.client = null;
    this.clientRequest = null;
    this.controller?.setModelsReady(false);
    await old?.dispose().catch(() => undefined);
    await this.ensureModels();
  }

  private onProgress(e: ProgressEvent): void {
    const phase = e.phase === 'ready' ? 'ready' : e.phase;
    const msg =
      e.phase === 'fetching'
        ? `Downloading ${e.asset ?? 'models'}…`
        : e.phase === 'verifying'
          ? `Verifying ${e.asset ?? 'models'}…`
          : e.phase === 'initializing'
            ? 'Starting OCR engine…'
            : (e.message ?? 'Ready');
    this.patchDiag({ phase, message: msg, progress: e.loadedBytes !== undefined && e.totalBytes ? { loaded: e.loadedBytes, total: e.totalBytes } : null });
  }

  private patchDiag(p: Partial<OcrDiagnosticsSnapshot>): void {
    this.diagnostics.set({ ...this.diagnostics(), ...p, inputClaims: this.gate?.activeReasons() ?? [] });
  }

  dispose(): void {
    this.unsubscribeLifecycle?.();
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = null;
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    for (const off of this.listeners) off();
    this.listeners = [];
    this.controller?.stop();
    this.gate?.detach();
    this.textLayer?.dispose();
    this.popup?.dispose();
    this.frames?.dispose();
    void this.client?.dispose();
    this.client = null;
    this.attached = false;
  }
}

function confidenceNote(published: PublishedLayout, hit: TextHit): string | undefined {
  const line = published.snapshot.lines.find((l) => l.id === hit.lineId);
  if (!line || line.glyphs.length === 0) return undefined;
  const avg = line.glyphs.reduce((a, g) => a + g.confidence, 0) / line.glyphs.length;
  return avg < 0.5 ? 'low confidence' : undefined;
}

function geometrySig(vp: { sourceWidth: number; sourceHeight: number; contentRect: { left: number; top: number; width: number; height: number } } | null, hr: DOMRect): string {
  const c = vp?.contentRect;
  const r = (n: number) => Math.round(n * 4) / 4;
  return `${vp?.sourceWidth ?? 0}x${vp?.sourceHeight ?? 0}|${c ? `${r(c.left)},${r(c.top)},${r(c.width)},${r(c.height)}` : '-'}|${r(hr.left)},${r(hr.top)},${r(hr.width)},${r(hr.height)}`;
}
