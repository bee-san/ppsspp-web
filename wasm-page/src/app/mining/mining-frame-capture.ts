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
  /** Copies attempted (including blank retries). */
  captures: number;
  /** Copies that came back all-black and were retried on the next frame. */
  blankRetries: number;
  /** Capture slots given up after MAX_BLANK_RETRIES consecutive black frames. */
  blank: number;
  encodeFailures: number;
  lastEncodeMs: number;
  lastSize: string;
}

/**
 * The emulator draws asynchronously to the display refresh; a rAF copy that lands
 * after the previous present but before the next draw sees a cleared buffer
 * (preserveDrawingBuffer:false). Retry on consecutive frames until content shows up.
 */
const MAX_BLANK_RETRIES = 8;

export class MiningFrameCapture {
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastCaptureMs = 0;
  private retriesLeft = MAX_BLANK_RETRIES;
  private scratch: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private encoding = false;
  readonly diag: FrameCaptureDiagnostics = { captures: 0, blankRetries: 0, blank: 0, encodeFailures: 0, lastEncodeMs: 0, lastSize: '' };

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
    this.lastCaptureMs = 0;
    this.retriesLeft = MAX_BLANK_RETRIES;
    this.scheduleFrame();
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Register the rAF copy from a timer task (not from inside rAF) so it queues after the emulator's own frame callback. */
  private scheduleFrame(): void {
    if (!this.running || this.raf) return;
    this.raf = requestAnimationFrame(() => this.tick());
  }

  private scheduleAfter(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleFrame();
    }, Math.max(0, ms));
  }

  private tick(): void {
    this.raf = 0;
    if (!this.running) return;
    const interval = 1000 / Math.max(1, this.opts.fps);
    const now = performance.now();
    if (this.encoding) {
      // Previous frame still encoding: look again shortly.
      this.scheduleAfter(Math.min(interval / 2, 20));
      return;
    }
    let outcome: 'stored' | 'blank' | 'none' = 'none';
    try {
      outcome = this.captureNow(now);
    } catch (e) {
      console.warn('[mining] frame capture failed', e);
    }
    if (outcome === 'blank' && this.retriesLeft > 0) {
      this.retriesLeft--;
      this.diag.blankRetries++;
      this.scheduleFrame(); // very next frame
      return;
    }
    if (outcome === 'blank') this.diag.blank++;
    this.retriesLeft = MAX_BLANK_RETRIES;
    // Anchor the cadence on a grid so retries/encodes do not drift it.
    this.lastCaptureMs = this.lastCaptureMs ? this.lastCaptureMs + interval * Math.max(1, Math.floor((now - this.lastCaptureMs) / interval)) : now;
    this.scheduleAfter(this.lastCaptureMs + interval - performance.now());
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

  private captureNow(wallTimeMs: number): 'stored' | 'blank' | 'none' {
    const canvas = this.bridge.getCanvas();
    if (!canvas || canvas.width === 0 || canvas.height === 0) return 'none';
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
    if (this.isBlank(ctx, w, h)) return 'blank';

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
    return 'stored';
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
