import { describe, expect, it } from 'vitest';
import { clampRange, defaultRange, dragHandle, formatOffset, formatSeconds, hitHandle, MIN_CLIP_MS, msToX, xToMs } from './mining-picker-math';

describe('picker math', () => {
  it('clampRange orders, clamps and enforces the minimum length', () => {
    expect(clampRange({ fromMs: 500, toMs: 100 }, 0, 1000)).toEqual({ fromMs: 100, toMs: 500 });
    expect(clampRange({ fromMs: -50, toMs: 2000 }, 0, 1000)).toEqual({ fromMs: 0, toMs: 1000 });
    expect(clampRange({ fromMs: 400, toMs: 410 }, 0, 1000)).toEqual({ fromMs: 400, toMs: 400 + MIN_CLIP_MS });
    // No room to the right: grow left.
    expect(clampRange({ fromMs: 990, toMs: 1000 }, 0, 1000)).toEqual({ fromMs: 1000 - MIN_CLIP_MS, toMs: 1000 });
    // Window shorter than the minimum: use the whole window.
    expect(clampRange({ fromMs: 0, toMs: 10 }, 0, 100)).toEqual({ fromMs: 0, toMs: 100 });
  });

  it('defaultRange is the last clipMs of the buffer', () => {
    expect(defaultRange(0, 20_000, 8000)).toEqual({ fromMs: 12_000, toMs: 20_000 });
    expect(defaultRange(15_000, 20_000, 8000)).toEqual({ fromMs: 15_000, toMs: 20_000 });
  });

  it('maps pixels ↔ time', () => {
    expect(xToMs(0, 200, 1000, 3000)).toBe(1000);
    expect(xToMs(100, 200, 1000, 3000)).toBe(2000);
    expect(xToMs(999, 200, 1000, 3000)).toBe(3000);
    expect(xToMs(50, 0, 1000, 3000)).toBe(1000);
    expect(msToX(2000, 200, 1000, 3000)).toBe(100);
    expect(msToX(2000, 200, 1000, 1000)).toBe(0);
  });

  it('dragHandle moves in/out/both within bounds', () => {
    const r = { fromMs: 1000, toMs: 3000 };
    expect(dragHandle(r, 'in', 500, 0, 5000)).toEqual({ fromMs: 1500, toMs: 3000 });
    expect(dragHandle(r, 'in', 5000, 0, 5000)).toEqual({ fromMs: 3000 - MIN_CLIP_MS, toMs: 3000 });
    expect(dragHandle(r, 'in', -5000, 0, 5000)).toEqual({ fromMs: 0, toMs: 3000 });
    expect(dragHandle(r, 'out', 1000, 0, 5000)).toEqual({ fromMs: 1000, toMs: 4000 });
    expect(dragHandle(r, 'out', -5000, 0, 5000)).toEqual({ fromMs: 1000, toMs: 1000 + MIN_CLIP_MS });
    expect(dragHandle(r, 'out', 9999, 0, 5000)).toEqual({ fromMs: 1000, toMs: 5000 });
    expect(dragHandle(r, 'both', 1000, 0, 5000)).toEqual({ fromMs: 2000, toMs: 4000 });
    expect(dragHandle(r, 'both', 9999, 0, 5000)).toEqual({ fromMs: 3000, toMs: 5000 });
    expect(dragHandle(r, 'both', -9999, 0, 5000)).toEqual({ fromMs: 0, toMs: 2000 });
  });

  it('hitHandle prefers the nearer edge, then the body', () => {
    const r = { fromMs: 1000, toMs: 3000 }; // at width 400 over 0..4000: x=100 and x=300
    expect(hitHandle(105, r, 400, 0, 4000)).toBe('in');
    expect(hitHandle(290, r, 400, 0, 4000)).toBe('out');
    expect(hitHandle(200, r, 400, 0, 4000)).toBe('both');
    expect(hitHandle(20, r, 400, 0, 4000)).toBeNull();
    expect(hitHandle(390, r, 400, 0, 4000)).toBeNull();
    // Tiny selection: both handles overlap → nearest wins.
    const tiny = { fromMs: 2000, toMs: 2010 };
    expect(hitHandle(199, tiny, 400, 0, 4000)).toBe('in');
    expect(hitHandle(202, tiny, 400, 0, 4000)).toBe('out');
  });

  it('formats seconds and offsets', () => {
    expect(formatSeconds(3210)).toBe('3.2 s');
    expect(formatSeconds(-5)).toBe('0.0 s');
    expect(formatOffset(15_500, 20_000)).toBe('−4.5 s');
    expect(formatOffset(20_000, 20_000)).toBe('+0.0 s');
  });
});
