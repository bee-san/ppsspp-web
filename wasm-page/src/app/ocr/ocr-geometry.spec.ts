import { describe, expect, it } from 'vitest';
import {
  captureScale,
  clientToImage,
  clientToNorm,
  contentRectFor,
  imageRectToCss,
  regionFromCorners,
  regionToSourceRect,
  scaledSize,
} from './ocr-coordinate-map';
import { isInPopupCorridor, positionPopup } from './ocr-popup-position';
import type { CaptureMeta } from './ocr-types';

describe('coordinate map', () => {
  const content = { left: 100, top: 50, width: 960, height: 544 };
  const src = { w: 480, h: 272 };

  it('clientToNorm maps corners and rejects outside points', () => {
    expect(clientToNorm(100, 50, content)).toEqual({ x: 0, y: 0 });
    expect(clientToNorm(1060, 594, content)).toEqual({ x: 1, y: 1 });
    expect(clientToNorm(99, 50, content)).toBeNull();
    expect(clientToNorm(580, 322, content)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('regionToSourceRect covers the region with integer bounds', () => {
    expect(regionToSourceRect({ x: 0, y: 0, w: 1, h: 1 }, src.w, src.h)).toEqual({ x: 0, y: 0, w: 480, h: 272 });
    expect(regionToSourceRect({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, src.w, src.h)).toEqual({ x: 240, y: 136, w: 240, h: 136 });
    expect(regionToSourceRect({ x: 0.333, y: 0, w: 0.333, h: 0.1 }, src.w, src.h)).toEqual({ x: 159, y: 0, w: 161, h: 28 });
  });

  it('regionFromCorners normalizes drag direction and clamps', () => {
    expect(regionFromCorners(0.8, 0.9, 0.2, 0.1)).toEqual({ x: 0.2, y: 0.1, w: 0.6000000000000001, h: 0.8 });
    expect(regionFromCorners(-1, -1, 2, 2)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('captureScale downsamples only when over budget', () => {
    expect(captureScale({ x: 0, y: 0, w: 480, h: 272 }, 1_000_000)).toBe(1);
    const s = captureScale({ x: 0, y: 0, w: 4000, h: 2000 }, 1_000_000);
    const sz = scaledSize({ x: 0, y: 0, w: 4000, h: 2000 }, s);
    expect(sz.width * sz.height).toBeLessThanOrEqual(1_000_000 * 1.01);
  });

  it('client → image round-trips through a downsampled crop', () => {
    const meta: CaptureMeta = {
      gameSessionId: 1,
      sceneEpoch: 1,
      geometryVersion: 1,
      region: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      cropRect: { x: 240, y: 136, w: 240, h: 136 },
      scale: 0.5,
      imageWidth: 120,
      imageHeight: 68,
    };
    // Client point at the crop's centre: norm (0.75, 0.75) → source (360, 204) → image (60, 34)
    const pt = clientToImage(100 + 0.75 * 960, 50 + 0.75 * 544, content, meta, src.w, src.h)!;
    expect(pt.x).toBeCloseTo(60);
    expect(pt.y).toBeCloseTo(34);
    // outside the crop → null
    expect(clientToImage(100 + 0.25 * 960, 50 + 0.25 * 544, content, meta, src.w, src.h)).toBeNull();
    // image box back to CSS
    const css = imageRectToCss([60, 34, 70, 44], meta, content, src.w, src.h);
    expect(css.left).toBeCloseTo(100 + 0.75 * 960);
    expect(css.top).toBeCloseTo(50 + 0.75 * 544);
    expect(css.width).toBeCloseTo((20 / 480) * 960);
    expect(css.height).toBeCloseTo((20 / 272) * 544);
  });

  it('contentRectFor letterboxes with object-fit: contain', () => {
    const box = { left: 0, top: 0, width: 1920, height: 1200 }; // 16:10 box, 16:9 source
    const r = contentRectFor(box, 1280, 720, 'contain');
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
    expect(r.top).toBe(60);
    const tall = contentRectFor({ left: 0, top: 0, width: 1000, height: 1000 }, 1280, 720, 'contain');
    expect(tall.width).toBe(1000);
    expect(tall.height).toBe(562.5);
    expect(tall.top).toBe(218.75);
    expect(contentRectFor(box, 1280, 720, 'fill')).toEqual(box);
  });
});

describe('positionPopup (MeikiPop move_to)', () => {
  const bounds = { left: 0, top: 0, width: 1000, height: 600 };
  const size = { width: 200, height: 100 };

  it('visual novel mode: below in upper third, above in lower third, interpolated x', () => {
    const upper = positionPopup(500, 100, size, bounds, 'visual_novel_mode');
    expect(upper.top).toBe(115);
    expect(upper.left).toBe(400); // centre at x = 500 → pos_center
    const lower = positionPopup(500, 500, size, bounds, 'visual_novel_mode');
    expect(lower.top).toBe(385);
    const leftEdge = positionPopup(0, 100, size, bounds, 'visual_novel_mode');
    expect(leftEdge.left).toBe(15); // pos_right = x + offset
    const rightEdge = positionPopup(999, 100, size, bounds, 'visual_novel_mode');
    expect(rightEdge.left).toBe(784); // pos_center*0.002 + pos_left*0.998 = 899*0.002 + 784*0.998
  });

  it('middle third splits at half height', () => {
    expect(positionPopup(500, 299, size, bounds, 'visual_novel_mode').top).toBe(314);
    expect(positionPopup(500, 301, size, bounds, 'visual_novel_mode').top).toBe(186);
  });

  it('flip modes flip when overflowing and push otherwise', () => {
    expect(positionPopup(900, 100, size, bounds, 'flip_horizontally')).toEqual({ left: 685, top: 115 });
    expect(positionPopup(100, 100, size, bounds, 'flip_horizontally')).toEqual({ left: 115, top: 115 });
    expect(positionPopup(100, 550, size, bounds, 'flip_vertically')).toEqual({ left: 115, top: 435 });
    expect(positionPopup(900, 550, size, bounds, 'flip_both')).toEqual({ left: 685, top: 435 });
  });

  it('final clamp keeps the popup inside bounds', () => {
    const p = positionPopup(-500, -500, size, bounds, 'flip_both');
    expect(p.left).toBeGreaterThanOrEqual(0);
    expect(p.top).toBeGreaterThanOrEqual(0);
    const q = positionPopup(5000, 5000, size, bounds, 'visual_novel_mode');
    expect(q.left + size.width).toBeLessThanOrEqual(bounds.width);
    expect(q.top + size.height).toBeLessThanOrEqual(bounds.height);
  });
});

describe('isInPopupCorridor', () => {
  const popup = { left: 300, top: 300, width: 200, height: 100 };
  it('accepts points inside the popup with margin and along the corridor', () => {
    expect(isInPopupCorridor({ x: 310, y: 310 }, { x: 100, y: 100 }, popup)).toBe(true);
    expect(isInPopupCorridor({ x: 200, y: 200 }, { x: 100, y: 100 }, popup)).toBe(true);
    expect(isInPopupCorridor({ x: 900, y: 900 }, { x: 100, y: 100 }, popup)).toBe(false);
  });
});
