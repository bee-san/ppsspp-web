/**
 * Typed wrapper around `window.PpssppReadingBridge` (defined in
 * public/ppsspp-runtime.js). Fails soft when the bridge version is missing or
 * mismatched: OCR stays unavailable, the emulator is unaffected.
 */
import type { BridgeState, LifecycleEvent } from './ocr-types';

export const READING_BRIDGE_VERSION = 1;

export interface RawReadingBridge {
  version: number;
  getState(): BridgeState;
  getCanvas(): HTMLCanvasElement | null;
  getStage(): HTMLElement | null;
  subscribeLifecycle(cb: (ev: LifecycleEvent) => void): () => void;
  setReadingInputClaim(reason: string, active: boolean): () => void;
  hasInputClaim(): boolean;
  isFullscreenActive(): boolean;
  requestFullscreen(): Promise<boolean>;
  exitFullscreen(): Promise<boolean>;
}

export class OcrRuntimeBridge {
  private constructor(private readonly raw: RawReadingBridge) {}

  static connect(win: Window & { PpssppReadingBridge?: unknown } = window): OcrRuntimeBridge | null {
    const raw = win.PpssppReadingBridge as RawReadingBridge | undefined;
    if (!raw || typeof raw !== 'object' || raw.version !== READING_BRIDGE_VERSION) return null;
    return new OcrRuntimeBridge(raw);
  }

  /** Poll until the classic runtime script has installed the bridge (bounded). */
  static async waitFor(timeoutMs = 10_000, win: Window = window): Promise<OcrRuntimeBridge | null> {
    const start = performance.now();
    for (;;) {
      const b = OcrRuntimeBridge.connect(win as Window & { PpssppReadingBridge?: unknown });
      if (b) return b;
      if (performance.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  getState(): BridgeState {
    return this.raw.getState();
  }
  getCanvas(): HTMLCanvasElement | null {
    return this.raw.getCanvas();
  }
  getStage(): HTMLElement | null {
    return this.raw.getStage();
  }
  subscribe(cb: (ev: LifecycleEvent) => void): () => void {
    return this.raw.subscribeLifecycle(cb);
  }
  /** Returns a release function; releasing twice is a no-op. */
  claimInput(reason: string): () => void {
    return this.raw.setReadingInputClaim(reason, true);
  }
  hasInputClaim(): boolean {
    return this.raw.hasInputClaim();
  }
  isFullscreen(): boolean {
    return this.raw.isFullscreenActive();
  }
}
