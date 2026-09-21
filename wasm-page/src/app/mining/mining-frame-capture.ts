/**
 * MiningFrameCapture — continuous low-fps capture of the game canvas into
 * encoded WebP stills.
 *
 * Same render-boundary rationale as OcrFrameSource: the copy runs inside a
 * requestAnimationFrame callback registered after the emulator's own, so the
 * WebGL drawing buffer (preserveDrawingBuffer:false) still holds this frame.
 * Frames are scaled to `maxWidth` on an opaque scratch canvas (so Chrome does
 * not emit VP8X+ALPH), encoded with `toBlob('image/webp', quality)` and pushed
 * to the FrameRingBuffer. All-black frames are skipped (isBlank sampling).
 * Capture pauses while the document is hidden or the game is not running.
 */
import type { FrameRingBuffer } from './frame-ring-buffer';
import type { MiningRuntimeBridge } from './mining-runtime-bridge';

export interface FrameCaptureOptions {
  fps: number;
  maxWidth: number;
  quality: number;
}

export interface FrameCaptureDiagnostics {
  captures: number;
  blank: number;
  encodeFailures: number;
  lastEncodeMs: number;
  lastSize: string;
}

export class MiningFrameCapture {
  private raf = 0;
  private running = false;
  private lastCaptureMs = 0;
  private scratch: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private encoding = false;
  readonly diag: FrameCaptureDiagnostics = { captures: 0, blank: 0, encodeFailures: 0, lastEncodeMs: 0, lastSize: '' };

  constructor(
    private readonly bridge: MiningRuntimeBridge,
    private readonly ring: FrameRingBuffer,
    private opts: FrameCaptureOptions,
  ) {}

  setOptions(o: FrameCaptureOptions): void {
    this.opts = o;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private schedule(): void {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    this.raf = 0;
    if (!this.running) return;
    try {
      const now = performance.now();
      const interval = 1000 / Math.max(1, this.opts.fps);
      if (!this.encoding && now - this.lastCaptureMs >= interval - 1) {
        // Anchor on a grid so long encodes do not drift the cadence.
        this.lastCaptureMs = this.lastCaptureMs ? this.lastCaptureMs + interval * Math.max(1, Math.floor((now - this.lastCaptureMs) / interval)) : now;
        this.captureNow(now);
      }
    } catch (e) {
      console.warn('[mining] frame capture failed', e);
    }
    this.schedule();
  }

  private ensureScratch(w: number, h: number): CanvasRenderingContext2D {
    if (!this.scratch) {
      // HTMLCanvasElement (not Offscreen): toBlob('image/webp') is supported on both Chrome and Firefox here.
      this.scratch = document.createElement('canvas');
      this.ctx = this.scratch.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!this.ctx) throw new Error('2D context unavailable for mining capture');
    }
    if (this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch.width = w;
      this.scratch.height = h;
    }
    return this.ctx!;
  }

  private captureNow(wallTimeMs: number): void {
    const canvas = this.bridge.getCanvas();
    if (!canvas || canvas.width === 0 || canvas.height === 0) return;
    const sw = canvas.width;
    const sh = canvas.height;
    const scale = Math.min(1, this.opts.maxWidth / sw);
    const w = Math.max(2, Math.round(sw * scale)) & ~1; // even sizes keep VP8 happy
    const h = Math.max(2, Math.round(sh * scale)) & ~1;
    const ctx = this.ensureScratch(w, h);
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.imageSmoothingQuality = 'medium';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0, sw, sh, 0, 0, w, h);
    this.diag.captures++;
    this.diag.lastSize = `${w}x${h}`;

    // Blank check on a sparse grid (16×16 samples) — cheap enough per frame.
    if (this.isBlank(ctx, w, h)) {
      this.diag.blank++;
      return;
    }

    this.encoding = true;
    const t0 = performance.now();
    const scratch = this.scratch!;
    scratch.toBlob(
      (blob) => {
        this.encoding = false;
        this.diag.lastEncodeMs = performance.now() - t0;
        if (!blob) {
          this.diag.encodeFailures++;
          return;
        }
        if (blob.type !== 'image/webp') {
          // Browser ignored the WebP request (very old engines); animated export would fail.
          this.diag.encodeFailures++;
          return;
        }
        this.ring.push({ wallTimeMs, blob, width: w, height: h });
      },
      'image/webp',
      this.opts.quality,
    );
  }

  private isBlank(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
    const cols = Math.min(16, w);
    const rows = Math.min(16, h);
    const stepX = w / cols;
    const stepY = h / rows;
    // 16 one-pixel-high row reads, 16 samples each: far cheaper than reading the whole frame.
    for (let r = 0; r < rows; r++) {
      const y = Math.min(h - 1, Math.floor(r * stepY + stepY / 2));
      const data = ctx.getImageData(0, y, w, 1).data;
      for (let c = 0; c < cols; c++) {
        const x = Math.min(w - 1, Math.floor(c * stepX + stepX / 2));
        const o = x * 4;
        if (data[o] || data[o + 1] || data[o + 2]) return false;
      }
    }
    return true;
  }

  dispose(): void {
    this.stop();
    this.scratch = null;
    this.ctx = null;
  }
}
