/**
 * Typed wrapper around `window.PpssppReadingBridge` v2 (public/ppsspp-runtime.js)
 * for sentence mining. Adds the synchronous audio tap on top of the v1 surface
 * used by OCR. Fails soft (returns null) when the runtime predates v2.
 */
import type { BridgeState, LifecycleEvent } from '../ocr/ocr-types';
import type { RawReadingBridge } from '../ocr/ocr-runtime-bridge';
import type { AudioTapChunk } from './mining-types';

export const MINING_BRIDGE_VERSION = 2;

export interface RawReadingBridgeV2 extends RawReadingBridge {
  addAudioTapListener(fn: (chunk: AudioTapChunk) => void): () => void;
  hasAudioTapListeners(): boolean;
}

export class MiningRuntimeBridge {
  private constructor(private readonly raw: RawReadingBridgeV2) {}

  static connect(win: Window & { PpssppReadingBridge?: unknown } = window): MiningRuntimeBridge | null {
    const raw = win.PpssppReadingBridge as RawReadingBridgeV2 | undefined;
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.version !== 'number' || raw.version < MINING_BRIDGE_VERSION) return null;
    if (typeof raw.addAudioTapListener !== 'function') return null;
    return new MiningRuntimeBridge(raw);
  }

  /** Poll until the classic runtime script has installed the bridge (bounded). */
  static async waitFor(timeoutMs = 10_000, win: Window = window): Promise<MiningRuntimeBridge | null> {
    const start = performance.now();
    for (;;) {
      const b = MiningRuntimeBridge.connect(win as Window & { PpssppReadingBridge?: unknown });
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
  /** Synchronous PCM tap; the chunk's buffers are reused by the runtime, copy before returning. */
  onAudio(fn: (chunk: AudioTapChunk) => void): () => void {
    return this.raw.addAudioTapListener(fn);
  }
  /** Key events delivered before the emulator and before the claim gate. */
  onKey(fn: (e: KeyboardEvent) => void): () => void {
    return this.raw.addReadingKeyListener(fn);
  }
  /** Balanced input claim; returns a release function (idempotent). */
  claimInput(reason: string): () => void {
    return this.raw.setReadingInputClaim(reason, true);
  }
  isFullscreen(): boolean {
    return this.raw.isFullscreenActive();
  }
}
