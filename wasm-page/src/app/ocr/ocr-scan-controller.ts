/**
 * OcrScanController — MeikiPop's scheduling behaviour translated to the browser.
 *
 * Reference behaviour (MeikiPop @ ed1b70c, input.py + screenmanager.py + ocr.py):
 *  - auto mode: initial screenshot on entering auto mode; screenshot trigger on
 *    every pointer movement (scanOnMouseMove) or periodically; hit scan on
 *    every pointer movement regardless of OCR; minimum interval between OCR
 *    submissions (0.5 s) enforced by sleeping and re-triggering (trailing);
 *    identical screenshots skip OCR; in movement mode a trigger is skipped
 *    when the pointer has not moved since the last screenshot; OCR completion
 *    re-triggers the screenshot path.
 *  - manual mode: capture on hotkey rising edge only.
 *  - latest-value queues: one active inference, one replaceable pending intent.
 *
 * Browser adaptations (documented, not attributed to MeikiPop): generation
 * guards for game/scene/region/config, hidden-tab suspension, bounded
 * failures, optional stale-image check while text is visible.
 *
 * This class has no DOM dependency. Timers and clock are injected.
 */
import type {
  CaptureMeta,
  CapturedGameFrame,
  LayoutSnapshot,
  NormRegion,
  OcrSettings,
  OcrSnapshot,
  PointerSample,
  PublishedLayout,
  TextHit,
} from './ocr-types';
import { FULL_REGION } from './ocr-types';
import { normToImage, regionsEqual } from './ocr-coordinate-map';

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export type ScanKind = 'initial' | 'movement' | 'periodic' | 'manual' | 'refresh' | 'invalidate';

export interface ControllerPorts {
  capture(region: NormRegion): Promise<CapturedGameFrame | null>;
  ocr(frame: CapturedGameFrame): Promise<OcrSnapshot>;
  buildLayout(snapshot: OcrSnapshot): LayoutSnapshot;
  hitTest(layout: LayoutSnapshot, imagePt: { x: number; y: number }): TextHit | null;
  /** Source framebuffer size, needed to map normalized pointer → image pixels. */
  sourceSize(): { width: number; height: number };
  onLayout(published: PublishedLayout | null): void;
  onHit(hit: TextHit | null, pointer: PointerSample | null, published: PublishedLayout | null): void;
  onActivationChange?(active: boolean): void;
  onDiagnostics?(d: ControllerDiagnostics): void;
  onError?(err: unknown, context: string): void;
}

export interface ControllerDiagnostics {
  scansRequested: number;
  scansSubmitted: number;
  scansSkippedUnchanged: number;
  scansSkippedThrottled: number;
  scansSkippedNoMotion: number;
  scansCompleted: number;
  scansStale: number;
  /** Stale checks that found changed pixels under visible text. */
  staleDetected: number;
  scansFailed: number;
  hitTests: number;
  captureFailures: number;
  lastScanMs: number;
  lastCaptureMs: number;
  activeInference: boolean;
  pendingIntent: ScanKind | null;
  generation: number;
  cachedLayout: boolean;
}

interface ComparedCrop {
  key: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Whether the inference for this crop succeeded (only successes are reusable). */
  snapshotGeneration: number;
}

export interface ControllerInputs {
  enabled: boolean;
  modelsReady: boolean;
  gameReady: boolean;
  documentVisible: boolean;
  pointerInside: boolean;
}

/** Minimum delay between movement-triggered captures after an unchanged image (MeikiPop: 0.1 s). */
export const UNCHANGED_BACKOFF_MS = 100;
/** Diagnostics coalescing interval. */
export const DIAG_MIN_INTERVAL_MS = 100;

export class OcrScanController {
  private settings: OcrSettings;
  private region: NormRegion = FULL_REGION;
  private modelSetId = 'unknown';

  private readonly inputs: ControllerInputs = {
    enabled: false,
    modelsReady: false,
    gameReady: false,
    documentVisible: true,
    pointerInside: false,
  };

  /** Bumped on game/scene/region/profile/model changes; stale completions are dropped. */
  private generation = 0;
  private pointer: PointerSample | null = null;
  private pointerMovedSinceLastScan = true;
  /** Time of the last "unchanged image" decision; movement captures back off UNCHANGED_BACKOFF_MS after it. */
  private lastUnchangedAt = -Infinity;
  private hotkeyDown = false;
  private hotkeyWasDown = false;
  private lastSubmitAt = -Infinity;
  private active: { kind: ScanKind; generation: number } | null = null;
  private pendingIntent: ScanKind | null = null;
  private forceNext = false;
  private throttleTimer: number | null = null;
  private periodicTimer: number | null = null;
  private staleTimer: number | null = null;
  private lastCompared: ComparedCrop | null = null;
  private published: PublishedLayout | null = null;
  private currentHit: TextHit | null = null;
  private autoModeEntered = false;
  private consecutiveFailures = 0;
  private stopped = false;

  private readonly diag: ControllerDiagnostics = {
    scansRequested: 0,
    scansSubmitted: 0,
    scansSkippedUnchanged: 0,
    scansSkippedThrottled: 0,
    scansSkippedNoMotion: 0,
    scansCompleted: 0,
    scansStale: 0,
    staleDetected: 0,
    scansFailed: 0,
    hitTests: 0,
    captureFailures: 0,
    lastScanMs: 0,
    lastCaptureMs: 0,
    activeInference: false,
    pendingIntent: null,
    generation: 0,
    cachedLayout: false,
  };

  constructor(
    private readonly ports: ControllerPorts,
    settings: OcrSettings,
    private readonly sched: Scheduler = realScheduler,
    private readonly framesEqual: (a: Uint8Array, b: Uint8Array) => boolean = bytesEqual,
  ) {
    this.settings = settings;
  }

  // ───────────────────────── configuration ─────────────────────────

  getSettings(): OcrSettings {
    return this.settings;
  }

  setSettings(next: OcrSettings): void {
    const prev = this.settings;
    this.settings = next;
    const hard = prev.ocrProfile !== next.ocrProfile || prev.ocrBackend !== next.ocrBackend || prev.maxCapturePixels !== next.maxCapturePixels;
    if (hard) this.invalidate('settings');
    const modeChanged = prev.autoScan !== next.autoScan || prev.scanOnMouseMove !== next.scanOnMouseMove || prev.scanIntervalMs !== next.scanIntervalMs;
    if (modeChanged) {
      // Intents and timers belong to the mode that created them: a movement/periodic
      // intent or trailing throttle from auto mode must not fire in manual mode
      // (MeikiPop's manual path has no interval and no movement trigger), and vice versa.
      this.pendingIntent = null;
      this.clearTimer('throttle');
      this.autoModeEntered = false;
      this.reschedulePeriodic();
      this.maybeEnterAutoMode();
    }
    if (prev.lookupsWithoutHotkey !== next.lookupsWithoutHotkey) this.rehit();
    this.rescheduleStaleCheck();
  }

  setModelSetId(id: string): void {
    if (id !== this.modelSetId) {
      this.modelSetId = id;
      this.invalidate('models');
    }
  }

  setRegion(region: NormRegion): void {
    if (regionsEqual(region, this.region)) return;
    this.region = region;
    this.invalidate('region');
  }

  getRegion(): NormRegion {
    return this.region;
  }

  // ───────────────────────── lifecycle inputs ─────────────────────────

  setEnabled(v: boolean): void {
    this.setInput('enabled', v);
  }
  setModelsReady(v: boolean): void {
    this.setInput('modelsReady', v);
  }
  setGameReady(v: boolean): void {
    this.setInput('gameReady', v);
  }
  setDocumentVisible(v: boolean): void {
    this.setInput('documentVisible', v);
  }

  private setInput<K extends keyof ControllerInputs>(k: K, v: ControllerInputs[K]): void {
    if (this.inputs[k] === v) return;
    this.inputs[k] = v;
    if (!this.eligible()) {
      this.suspend();
      // OCR off / game stopped: the old result must not remain (or become) interactive.
      // A hidden tab keeps its cache for a fast return (activation is already cleared).
      if (k === 'enabled' || k === 'gameReady') this.clearPublished();
    } else {
      this.autoModeEntered = false;
      this.maybeEnterAutoMode();
      this.reschedulePeriodic();
      this.rescheduleStaleCheck();
    }
  }

  private eligible(): boolean {
    return !this.stopped && this.inputs.enabled && this.inputs.modelsReady && this.inputs.gameReady && this.inputs.documentVisible;
  }

  /** Hidden tab / disabled / game stopped: cancel pending work, clear held state, hide UI. */
  private suspend(): void {
    this.pendingIntent = null;
    this.forceNext = false;
    this.clearTimer('throttle');
    this.clearTimer('periodic');
    this.clearTimer('stale');
    this.hotkeyDown = false;
    this.hotkeyWasDown = false;
    this.autoModeEntered = false;
    if (this.currentHit) {
      this.currentHit = null;
      this.ports.onHit(null, this.pointer, this.published);
    }
    this.ports.onActivationChange?.(false);
    this.emitDiag();
  }

  /** Game / scene / region / model / profile changed: old results may never appear. */
  invalidate(reason: string): void {
    this.generation++;
    this.lastCompared = null;
    this.pendingIntent = null;
    this.forceNext = false;
    this.clearTimer('throttle');
    if (this.published) {
      this.published = null;
      this.ports.onLayout(null);
    }
    if (this.currentHit) {
      this.currentHit = null;
      this.ports.onHit(null, this.pointer, null);
    }
    this.pointerMovedSinceLastScan = true;
    this.autoModeEntered = false;
    this.diag.generation = this.generation;
    void reason;
    this.maybeEnterAutoMode();
    this.rescheduleStaleCheck();
  }

  /**
   * Pure CSS resize/zoom: transforms are the presentation layer's job; nothing to
   * re-infer. A change of the *source* framebuffer size, however, invalidates
   * cached captures (plan §6): the layout's crop rectangle no longer maps.
   */
  geometryChanged(sourceWidth?: number, sourceHeight?: number): void {
    const pub = this.published;
    if (pub && sourceWidth !== undefined && sourceHeight !== undefined && (pub.meta.sourceWidth !== sourceWidth || pub.meta.sourceHeight !== sourceHeight)) {
      this.invalidate('source-size');
      return;
    }
    this.rehit();
  }

  stop(): void {
    this.stopped = true;
    this.suspend();
    this.clearPublished();
    if (this.diagTimer !== null) {
      this.sched.clearTimeout(this.diagTimer);
      this.diagTimer = null;
    }
  }

  private clearPublished(): void {
    this.lastCompared = null;
    if (this.published) {
      this.published = null;
      this.diag.cachedLayout = false;
      this.ports.onLayout(null);
    }
  }

  // ───────────────────────── pointer / keys ─────────────────────────

  pointerMove(sample: PointerSample): void {
    const moved = !this.pointer || this.pointer.clientX !== sample.clientX || this.pointer.clientY !== sample.clientY;
    this.pointer = sample;
    this.inputs.pointerInside = sample.norm !== null;
    if (!moved) return;
    this.pointerMovedSinceLastScan = true;
    // Movement triggers a hit scan even without new OCR.
    this.rehit();
    if (!this.eligible()) return;
    if (this.settings.autoScan && this.settings.scanOnMouseMove && sample.norm) {
      this.requestScan('movement');
    }
  }

  pointerLeave(): void {
    this.inputs.pointerInside = false;
    if (this.pointer) this.pointer = { ...this.pointer, norm: null };
    // Stop new movement-triggered work; keep results for a fast return.
    if (this.pendingIntent === 'movement') this.pendingIntent = null;
    this.rehit();
  }

  /** Key edge from the DOM; repeats must be filtered by the caller or here via `hotkeyWasDown`. */
  hotkeyDownEdge(): void {
    if (this.hotkeyWasDown) return; // key repeat
    this.hotkeyDown = true;
    this.hotkeyWasDown = true;
    if (!this.eligible()) return;
    if (!this.settings.autoScan) this.requestScan('manual');
    this.rehit();
    this.ports.onActivationChange?.(this.activationAllowed());
  }

  hotkeyUp(): void {
    this.hotkeyDown = false;
    this.hotkeyWasDown = false;
    this.rehit();
    this.ports.onActivationChange?.(this.activationAllowed());
  }

  /** Explicit refresh bypasses image equality once. */
  refresh(): void {
    if (!this.eligible()) return;
    this.forceNext = true;
    this.requestScan('refresh');
  }

  /** MeikiPop `is_virtual_hotkey_down`: hotkey held, or auto mode with hotkey-free lookups. */
  activationAllowed(): boolean {
    return this.hotkeyDown || (this.settings.autoScan && this.settings.lookupsWithoutHotkey);
  }

  getPublished(): PublishedLayout | null {
    return this.published;
  }

  getCurrentHit(): TextHit | null {
    return this.currentHit;
  }

  // ───────────────────────── scheduling core ─────────────────────────

  private maybeEnterAutoMode(): void {
    if (!this.eligible() || !this.settings.autoScan || this.autoModeEntered) return;
    this.autoModeEntered = true;
    this.requestScan('initial');
  }

  private requestScan(kind: ScanKind): void {
    this.diag.scansRequested++;
    // Latest intent replaces the previous one, but a stronger kind is not downgraded by movement.
    if (this.pendingIntent === null || kind !== 'movement') this.pendingIntent = kind;
    this.service();
  }

  private service(): void {
    if (!this.eligible() || this.pendingIntent === null) {
      this.emitDiag();
      return;
    }
    if (this.active) {
      // One active inference; the intent waits and is serviced on completion.
      this.emitDiag();
      return;
    }
    const kind = this.pendingIntent;
    const now = this.sched.now();

    if (this.settings.autoScan) {
      const since = now - this.lastSubmitAt;
      if (since < this.settings.scanIntervalMs) {
        // Preserve the latest intent; service it when eligible (trailing scan).
        this.diag.scansSkippedThrottled++;
        this.armThrottle(this.settings.scanIntervalMs - since);
        this.emitDiag();
        return;
      }
      const sinceUnchanged = now - this.lastUnchangedAt;
      if (kind === 'movement' && sinceUnchanged < UNCHANGED_BACKOFF_MS) {
        this.armThrottle(UNCHANGED_BACKOFF_MS - sinceUnchanged);
        return;
      }
      // Movement-only mode: no screenshot without pointer movement since the last one.
      if (kind === 'movement' && this.settings.scanOnMouseMove && !this.pointerMovedSinceLastScan) {
        this.diag.scansSkippedNoMotion++;
        this.pendingIntent = null;
        this.emitDiag();
        return;
      }
    }

    this.pendingIntent = null;
    this.clearTimer('throttle');
    void this.captureAndMaybeInfer(kind);
  }

  private armThrottle(delay: number): void {
    if (this.throttleTimer !== null) return;
    this.throttleTimer = this.sched.setTimeout(() => {
      this.throttleTimer = null;
      this.service();
    }, Math.max(0, Math.ceil(delay)));
  }

  private async captureAndMaybeInfer(kind: ScanKind): Promise<void> {
    const generation = this.generation;
    this.active = { kind, generation };
    this.pointerMovedSinceLastScan = false;
    this.emitDiag();

    let captured: CapturedGameFrame | null = null;
    const t0 = this.sched.now();
    try {
      captured = await this.ports.capture(this.region);
    } catch (e) {
      this.ports.onError?.(e, 'capture');
    }
    this.diag.lastCaptureMs = this.sched.now() - t0;

    if (generation !== this.generation || !this.eligible()) {
      this.active = null;
      this.diag.scansStale++;
      this.afterScan();
      return;
    }
    if (!captured) {
      this.diag.captureFailures++;
      this.active = null;
      this.afterScan();
      return;
    }

    const bytes = new Uint8Array(captured.frame.rgba);
    const key = this.compareKey(captured.meta);
    const force = this.forceNext;
    this.forceNext = false;

    if (
      !force &&
      this.lastCompared &&
      this.lastCompared.key === key &&
      this.lastCompared.width === captured.frame.width &&
      this.lastCompared.height === captured.frame.height &&
      this.lastCompared.snapshotGeneration === generation &&
      this.framesEqual(this.lastCompared.bytes, bytes)
    ) {
      // Identical image: reuse recognized geometry; no inference. Back off further
      // captures for a short period (MeikiPop sleeps 0.1 s after an identical shot)
      // so a moving pointer does not trigger a readback + compare every frame.
      this.diag.scansSkippedUnchanged++;
      this.lastUnchangedAt = this.sched.now();
      this.active = null;
      this.rehit();
      this.afterScan();
      return;
    }

    this.diag.scansSubmitted++;
    this.lastSubmitAt = this.sched.now();
    const t1 = this.sched.now();
    // The OCR port may transfer (detach) the frame buffer to its worker; keep an
    // owned copy so unchanged-image detection and the stale check stay valid.
    const kept = bytes.slice();
    try {
      const snapshot = await this.ports.ocr(captured);
      const dt = this.sched.now() - t1;
      if (generation !== this.generation || !this.eligible()) {
        this.diag.scansStale++;
        return;
      }
      this.diag.scansCompleted++;
      this.diag.lastScanMs = dt;
      this.consecutiveFailures = 0;
      // Only successful inference marks the crop as "seen" (failures stay retryable).
      this.lastCompared = { key, bytes: kept, width: captured.frame.width, height: captured.frame.height, snapshotGeneration: generation };
      const layout = this.ports.buildLayout(snapshot);
      this.published = { layout, snapshot, meta: captured.meta, generation, publishedAtMs: this.sched.now() };
      this.diag.cachedLayout = true;
      this.ports.onLayout(this.published);
      // Hit-test the *current* pointer, not the one captured when inference began.
      this.rehit();
    } catch (e) {
      this.diag.scansFailed++;
      this.consecutiveFailures++;
      this.ports.onError?.(e, 'ocr');
    } finally {
      this.active = null;
      this.afterScan();
    }
  }

  /** MeikiPop's OCR thread re-sets the screenshot trigger after each OCR in auto mode. */
  private afterScan(): void {
    if (!this.eligible()) {
      this.emitDiag();
      return;
    }
    if (this.pendingIntent !== null) {
      this.service();
    } else if (this.settings.autoScan && !this.settings.scanOnMouseMove) {
      this.reschedulePeriodic();
    }
    this.rescheduleStaleCheck();
    this.emitDiag();
  }

  private compareKey(meta: CaptureMeta): string {
    const r = meta.region;
    return `${this.settings.ocrProfile}|${this.modelSetId}|${r.x.toFixed(6)},${r.y.toFixed(6)},${r.w.toFixed(6)},${r.h.toFixed(6)}|${meta.cropRect.x},${meta.cropRect.y},${meta.cropRect.w},${meta.cropRect.h}|${meta.imageWidth}x${meta.imageHeight}`;
  }

  // ───────────────────────── periodic + stale ─────────────────────────

  private reschedulePeriodic(): void {
    this.clearTimer('periodic');
    if (!this.eligible() || !this.settings.autoScan || this.settings.scanOnMouseMove) return;
    this.periodicTimer = this.sched.setTimeout(() => {
      this.periodicTimer = null;
      if (!this.eligible()) return;
      this.requestScan('periodic');
    }, this.settings.scanIntervalMs);
  }

  /**
   * Browser adaptation: while spatial text is visible, compare the raw crop at
   * most once per interval. If pixels changed, retire the stale hit targets;
   * defer inference to the next movement in movement mode, or rescan in periodic mode.
   */
  private rescheduleStaleCheck(): void {
    this.clearTimer('stale');
    if (!this.eligible() || this.settings.stalePolicy === 'off' || !this.published) return;
    if (this.settings.autoScan && !this.settings.scanOnMouseMove) return; // periodic already rescans
    if (!this.activationAllowed()) return; // no spatial text visible (key not held): nothing to keep fresh
    this.staleTimer = this.sched.setTimeout(() => {
      this.staleTimer = null;
      void this.runStaleCheck();
    }, Math.max(this.settings.scanIntervalMs, 250));
  }

  private async runStaleCheck(): Promise<void> {
    if (!this.eligible() || !this.published || this.active || !this.lastCompared) {
      this.rescheduleStaleCheck();
      return;
    }
    const generation = this.generation;
    let captured: CapturedGameFrame | null = null;
    try {
      captured = await this.ports.capture(this.region);
    } catch (e) {
      this.ports.onError?.(e, 'stale-check');
    }
    if (generation !== this.generation || !this.published || !this.lastCompared) return;
    if (captured) {
      const bytes = new Uint8Array(captured.frame.rgba);
      const same =
        this.lastCompared.width === captured.frame.width &&
        this.lastCompared.height === captured.frame.height &&
        this.framesEqual(this.lastCompared.bytes, bytes);
      if (!same) {
        this.pointerMovedSinceLastScan = true; // the next movement scan re-infers
        this.lastCompared = null; // and must not be skipped as "unchanged"
        this.diag.staleDetected++;
        if (this.settings.stalePolicy === 'remove') {
          // Retire spatial targets; next movement/hotkey may re-infer.
          this.published = null;
          this.diag.cachedLayout = false;
          this.ports.onLayout(null);
          if (this.currentHit) {
            this.currentHit = null;
            this.ports.onHit(null, this.pointer, null);
          }
          this.emitDiag();
          return;
        }
        // 'mark': keep the text readable, flag it as possibly outdated, keep checking.
        if (!this.published.stale) {
          this.published = { ...this.published, stale: true };
          this.ports.onLayout(this.published);
        }
        this.emitDiag();
      }
    }
    this.rescheduleStaleCheck();
  }

  // ───────────────────────── hit testing ─────────────────────────

  private rehit(): void {
    const pub = this.published;
    let hit: TextHit | null = null;
    if (pub && this.pointer?.norm && this.eligible() && this.activationAllowed()) {
      const src = this.ports.sourceSize();
      const pt = normToImage(this.pointer.norm, pub.meta, src.width, src.height);
      if (pt) {
        this.diag.hitTests++;
        hit = this.ports.hitTest(pub.layout, pt);
      }
    }
    const changed = !sameHit(hit, this.currentHit);
    this.currentHit = hit;
    if (changed || hit) this.ports.onHit(hit, this.pointer, pub);
  }

  // ───────────────────────── util ─────────────────────────

  private clearTimer(which: 'throttle' | 'periodic' | 'stale'): void {
    const id = which === 'throttle' ? this.throttleTimer : which === 'periodic' ? this.periodicTimer : this.staleTimer;
    if (id !== null) this.sched.clearTimeout(id);
    if (which === 'throttle') this.throttleTimer = null;
    else if (which === 'periodic') this.periodicTimer = null;
    else this.staleTimer = null;
  }

  private diagTimer: number | null = null;
  private lastDiagAt = -Infinity;

  /** Diagnostics are UI state; coalesce to ≤ 10 Hz so pointer events do not drive Angular updates. */
  private emitDiag(): void {
    if (!this.ports.onDiagnostics) return;
    const now = this.sched.now();
    if (now - this.lastDiagAt >= DIAG_MIN_INTERVAL_MS) {
      this.flushDiag(now);
      return;
    }
    if (this.diagTimer !== null) return;
    this.diagTimer = this.sched.setTimeout(() => {
      this.diagTimer = null;
      this.flushDiag(this.sched.now());
    }, DIAG_MIN_INTERVAL_MS - (now - this.lastDiagAt));
  }

  private flushDiag(now: number): void {
    this.lastDiagAt = now;
    this.diag.activeInference = this.active !== null;
    this.diag.pendingIntent = this.pendingIntent;
    this.diag.generation = this.generation;
    this.diag.cachedLayout = this.published !== null;
    this.ports.onDiagnostics?.({ ...this.diag });
  }

  getDiagnostics(): ControllerDiagnostics {
    return { ...this.diag, activeInference: this.active !== null, pendingIntent: this.pendingIntent, generation: this.generation, cachedLayout: this.published !== null };
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  // Fast path: compare 4 bytes at a time when aligned.
  const n = a.byteLength;
  if ((a.byteOffset & 3) === 0 && (b.byteOffset & 3) === 0 && (n & 3) === 0) {
    const a32 = new Uint32Array(a.buffer, a.byteOffset, n >> 2);
    const b32 = new Uint32Array(b.buffer, b.byteOffset, n >> 2);
    for (let i = 0; i < a32.length; i++) if (a32[i] !== b32[i]) return false;
    return true;
  }
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameHit(a: TextHit | null, b: TextHit | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.paragraphId === b.paragraphId && a.glyphId === b.glyphId && a.utf16Offset === b.utf16Offset && a.fullText === b.fullText;
}
