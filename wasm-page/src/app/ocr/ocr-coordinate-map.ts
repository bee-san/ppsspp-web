/**
 * Coordinate transforms between the systems described in Plan 2 §8:
 *   1. viewport CSS (clientX/clientY)
 *   2. displayed game-content rectangle (excluding letterboxing)
 *   3. emulator source framebuffer pixels
 *   4. captured region / downsampled OCR image pixels
 *   5. layout glyph boxes (= OCR image pixels)
 *
 * Pure functions; unit tested. No DPR multiplier is applied because CSS and
 * backing sizes are related by the explicit content-rect / source ratios.
 */
import type { CaptureMeta, CssRect, NormRegion, PxRect } from './ocr-types';

export function clampRegion(r: NormRegion): NormRegion {
  const x = Math.min(1, Math.max(0, r.x));
  const y = Math.min(1, Math.max(0, r.y));
  const w = Math.min(1 - x, Math.max(0, r.w));
  const h = Math.min(1 - y, Math.max(0, r.h));
  return { x, y, w, h };
}

/** Normalize a region so w/h are positive (drag in any direction). */
export function regionFromCorners(x0: number, y0: number, x1: number, y1: number): NormRegion {
  return clampRegion({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
}

export function regionsEqual(a: NormRegion | null, b: NormRegion | null, eps = 1e-6): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps;
}

/** Convert a normalized region to an integer source-pixel crop (>= 1x1 when non-empty). */
export function regionToSourceRect(region: NormRegion, sourceW: number, sourceH: number): PxRect {
  const r = clampRegion(region);
  const x0 = Math.floor(r.x * sourceW);
  const y0 = Math.floor(r.y * sourceH);
  const x1 = Math.min(sourceW, Math.ceil((r.x + r.w) * sourceW));
  const y1 = Math.min(sourceH, Math.ceil((r.y + r.h) * sourceH));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * Choose a downsample factor so the capture stays within `maxPixels`.
 * Returns 1 when the crop already fits. Never upsamples.
 */
export function captureScale(crop: PxRect, maxPixels: number): number {
  const px = crop.w * crop.h;
  if (px <= maxPixels || px === 0) return 1;
  return Math.sqrt(maxPixels / px);
}

export function scaledSize(crop: PxRect, scale: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(crop.w * scale)), height: Math.max(1, Math.round(crop.h * scale)) };
}

/** Client CSS point -> normalized game-viewport coordinates, or null outside the content rect. */
export function clientToNorm(clientX: number, clientY: number, content: CssRect): { x: number; y: number } | null {
  if (content.width <= 0 || content.height <= 0) return null;
  const x = (clientX - content.left) / content.width;
  const y = (clientY - content.top) / content.height;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y };
}

/** Normalized viewport point -> OCR image pixels for a given capture, or null if outside the crop. */
export function normToImage(pt: { x: number; y: number }, meta: CaptureMeta, sourceW: number, sourceH: number): { x: number; y: number } | null {
  const sx = pt.x * sourceW;
  const sy = pt.y * sourceH;
  const { cropRect, scale } = meta;
  if (sx < cropRect.x || sy < cropRect.y || sx > cropRect.x + cropRect.w || sy > cropRect.y + cropRect.h) return null;
  return { x: (sx - cropRect.x) * scale, y: (sy - cropRect.y) * scale };
}

/**
 * Final mapping for an unrotated crop that maps directly to a CSS rectangle:
 *   imageX = (clientX - cropCssLeft) * imageWidth / cropCssWidth
 */
export function clientToImage(
  clientX: number,
  clientY: number,
  content: CssRect,
  meta: CaptureMeta,
  sourceW: number,
  sourceH: number,
): { x: number; y: number } | null {
  const n = clientToNorm(clientX, clientY, content);
  return n ? normToImage(n, meta, sourceW, sourceH) : null;
}

/** OCR image pixel rect -> CSS rect in viewport coordinates. */
export function imageRectToCss(
  box: readonly [number, number, number, number],
  meta: CaptureMeta,
  content: CssRect,
  sourceW: number,
  sourceH: number,
): CssRect {
  const cssPerSourceX = content.width / sourceW;
  const cssPerSourceY = content.height / sourceH;
  const sx0 = meta.cropRect.x + box[0] / meta.scale;
  const sy0 = meta.cropRect.y + box[1] / meta.scale;
  const sx1 = meta.cropRect.x + box[2] / meta.scale;
  const sy1 = meta.cropRect.y + box[3] / meta.scale;
  return {
    left: content.left + sx0 * cssPerSourceX,
    top: content.top + sy0 * cssPerSourceY,
    width: (sx1 - sx0) * cssPerSourceX,
    height: (sy1 - sy0) * cssPerSourceY,
  };
}

/**
 * Displayed content rectangle for a canvas with `object-fit: contain`-like
 * letterboxing (fullscreen CSS in this shell) or plain stretch. Given the CSS
 * box and the source aspect, compute the content rect inside the CSS box.
 */
export function contentRectFor(cssBox: CssRect, sourceW: number, sourceH: number, mode: 'contain' | 'fill'): CssRect {
  if (mode === 'fill' || sourceW <= 0 || sourceH <= 0 || cssBox.width <= 0 || cssBox.height <= 0) return { ...cssBox };
  const boxAspect = cssBox.width / cssBox.height;
  const srcAspect = sourceW / sourceH;
  if (Math.abs(boxAspect - srcAspect) < 1e-6) return { ...cssBox };
  if (boxAspect > srcAspect) {
    const w = cssBox.height * srcAspect;
    return { left: cssBox.left + (cssBox.width - w) / 2, top: cssBox.top, width: w, height: cssBox.height };
  }
  const h = cssBox.width / srcAspect;
  return { left: cssBox.left, top: cssBox.top + (cssBox.height - h) / 2, width: cssBox.width, height: h };
}
