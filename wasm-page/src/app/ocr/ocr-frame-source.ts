/**
 * OcrFrameSource — owns raw game-pixel capture from the emulator canvas.
 *
 * Capture strategy (Plan 2 §6): copy the WebGL canvas into a private 2D canvas
 * inside a requestAnimationFrame callback. The emulator's main loop is rAF
 * driven; a callback registered after its own runs later in the same frame,
 * before the drawing buffer is presented and (with preserveDrawingBuffer:false)
 * discarded. Only a pending request causes a copy; nothing runs continuously.
 *
 * Diagnostics count all-black captures so a persistently blank result is
 * visible; black is not treated as failure (a black frame can be legitimate).
 * If captures are blank on a given browser, the opt-in fallback
 * `localStorage.ppsspp_ocr_preserve_drawing_buffer = "1"` (applied at the next
 * emulator start) makes the buffer readable outside the render callback.
 */
import type { BridgeViewport, CapturedGameFrame, CssRect, NormRegion } from './ocr-types';
import { captureScale, contentRectFor, regionToSourceRect, scaledSize } from './ocr-coordinate-map';
import type { OcrRuntimeBridge } from './ocr-runtime-bridge';

export interface FrameSourceDiagnostics {
  captures: number;
  blankCaptures: number;
  /** Blank frames that were retried one frame later because the previous capture had content. */
  blankRetries: number;
  lastCaptureMs: number;
  lastImageSize: string;
  geometryVersion: number;
}

export class OcrFrameSource {
  private scratch: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private lastGeom: { w: number; h: number; rect: string } | null = null;
  private geometryVersion = 0;
  private frameCounter = 0;
  readonly diag: FrameSourceDiagnostics = { captures: 0, blankCaptures: 0, blankRetries: 0, lastCaptureMs: 0, lastImageSize: '', geometryVersion: 0 };

  constructor(
    private readonly bridge: OcrRuntimeBridge,
    private readonly maxPixels: () => number,
  ) {}

  /** Source size + displayed content rect. Increments geometryVersion on change. */
  getViewport(): BridgeViewport | null {
    const canvas = this.bridge.getCanvas();
    if (!canvas) return null;
    // Border-box minus the CSS border (the windowed canvas has a 1 px border):
    // pointer→image mapping must use the padding box that the pixels occupy.
    const cssBox = canvas.getBoundingClientRect();
    const bl = canvas.clientLeft;
    const bt = canvas.clientTop;
    const bw = Math.max(0, cssBox.width - (canvas.offsetWidth - canvas.clientWidth));
    const bh = Math.max(0, cssBox.height - (canvas.offsetHeight - canvas.clientHeight));
    const box: CssRect = { left: cssBox.left + bl, top: cssBox.top + bt, width: bw || cssBox.width, height: bh || cssBox.height };
    // Letterboxing inside the CSS box happens only via object-fit (the shell sets
    // `object-fit: contain` in fullscreen); without it a canvas is always stretched to
    // its box, whatever the backing aspect. Read the truth from computed style.
    const fit = contentFit(canvas, box);
    const contentRect = contentRectFor(box, canvas.width, canvas.height, fit);
    const sig = `${Math.round(contentRect.left)},${Math.round(contentRect.top)},${Math.round(contentRect.width)},${Math.round(contentRect.height)}`;
    if (!this.lastGeom || this.lastGeom.w !== canvas.width || this.lastGeom.h !== canvas.height || this.lastGeom.rect !== sig) {
      this.lastGeom = { w: canvas.width, h: canvas.height, rect: sig };
      this.geometryVersion++;
      this.diag.geometryVersion = this.geometryVersion;
    }
    return { sourceWidth: canvas.width, sourceHeight: canvas.height, contentRect, geometryVersion: this.geometryVersion };
  }

  /** Capture the region at the next render boundary. Resolves null when no game canvas is available. */
  capture(region: NormRegion): Promise<CapturedGameFrame | null> {
    const canvas = this.bridge.getCanvas();
    if (!canvas || canvas.width === 0 || canvas.height === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const attempt = (retriesLeft: number) => {
        requestAnimationFrame(() => {
          try {
            const got = this.copyNow(canvas, region);
            // Render-boundary race (observed on slow hosts): a rAF copy can land after the
            // presented buffer was cleared and before the emulator drew again, yielding an
            // all-black frame although the scene is not black. If the previous capture had
            // content, retry once on the next frame. A repeatedly black frame is accepted as
            // legitimately black (plan §6).
            if (got && got.blank && this.lastHadContent && retriesLeft > 0) {
              this.diag.blankRetries++;
              attempt(retriesLeft - 1);
              return;
            }
            if (got) this.lastHadContent = !got.blank;
            resolve(got ? got.frame : null);
          } catch (e) {
            console.warn('[ocr] capture failed', e);
            resolve(null);
          }
        });
      };
      attempt(1);
    });
  }

  private lastHadContent = true;

  private ensureScratch(w: number, h: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
    if (!this.scratch) {
      this.scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
      this.ctx = this.scratch.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      if (!this.ctx) throw new Error('2D context unavailable for OCR capture');
    }
    if (this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch.width = w;
      this.scratch.height = h;
    }
    return this.ctx!;
  }

  private copyNow(canvas: HTMLCanvasElement, region: NormRegion): { frame: CapturedGameFrame; blank: boolean } | null {
    const t0 = performance.now();
    const state = this.bridge.getState();
    const vp = this.getViewport();
    if (!vp) return null;
    const crop = regionToSourceRect(region, canvas.width, canvas.height);
    if (crop.w <= 0 || crop.h <= 0) return null;
    const scale = captureScale(crop, this.maxPixels());
    const { width, height } = scaledSize(crop, scale);
    const ctx = this.ensureScratch(width, height);
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
    const img = ctx.getImageData(0, 0, width, height);
    const rgba = img.data.buffer as ArrayBuffer;

    this.diag.captures++;
    this.diag.lastCaptureMs = performance.now() - t0;
    this.diag.lastImageSize = `${width}x${height}`;
    const blank = isBlank(img.data);
    if (blank) this.diag.blankCaptures++;

    const frame: CapturedGameFrame = {
      frame: { frameId: `g${state.gameSessionId}s${state.sceneEpoch}f${++this.frameCounter}`, width, height, capturedAtMs: t0, rgba },
      meta: {
        gameSessionId: state.gameSessionId,
        sceneEpoch: state.sceneEpoch,
        geometryVersion: vp.geometryVersion,
        region,
        cropRect: crop,
        scale: width / crop.w,
        imageWidth: width,
        imageHeight: height,
        sourceWidth: vp.sourceWidth,
        sourceHeight: vp.sourceHeight,
      },
    };
    return { frame, blank };
  }

  dispose(): void {
    this.scratch = null;
    this.ctx = null;
  }
}

/** Sample a sparse grid; "blank" = all sampled RGB channels zero. */
function isBlank(data: Uint8ClampedArray): boolean {
  const n = data.length >> 2;
  const step = Math.max(1, Math.floor(n / 256));
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    if (data[o] || data[o + 1] || data[o + 2]) return false;
  }
  return true;
}

/**
 * Non-fullscreen: the shell sizes the canvas element with `aspect-ratio: 16/9`
 * and PPSSPP resizes its backing store to match, so the content fills the box.
 * If the backing aspect ever differs from the CSS box we assume letterboxing.
 */
function contentFit(canvas: HTMLCanvasElement, box: CssRect): 'contain' | 'fill' {
  if (box.width <= 0 || box.height <= 0 || canvas.width <= 0 || canvas.height <= 0) return 'fill';
  const fit = typeof getComputedStyle === 'function' ? getComputedStyle(canvas).objectFit : '';
  // `scale-down` behaves like contain here (the backing store is never smaller than the box
  // by more than rounding); `cover`/`none` are not used by the shell.
  return fit === 'contain' || fit === 'scale-down' ? 'contain' : 'fill';
}
