import { describe, expect, it } from 'vitest';
import { FrameRingBuffer, frameIndexForTime } from './frame-ring-buffer';
import type { BufferedFrame } from './mining-types';

function frame(wallTimeMs: number, size = 10): BufferedFrame {
  return { wallTimeMs, blob: new Blob([new Uint8Array(size)]), width: 4, height: 3 };
}

describe('FrameRingBuffer', () => {
  it('evicts entries older than maxAge relative to the newest', () => {
    const ring = new FrameRingBuffer(1000);
    for (let t = 0; t <= 2000; t += 250) ring.push(frame(t));
    expect(ring.length).toBe(5); // 1000..2000
    expect(ring.startMs()).toBe(1000);
    expect(ring.latest()!.wallTimeMs).toBe(2000);
    expect(ring.byteLength).toBe(50);
  });

  it('never evicts the newest frame even with a zero max age', () => {
    const ring = new FrameRingBuffer(0);
    ring.push(frame(1));
    ring.push(frame(2));
    expect(ring.length).toBe(1);
    expect(ring.latest()!.wallTimeMs).toBe(2);
  });

  it('setMaxAge shrinks immediately and grows lazily', () => {
    const ring = new FrameRingBuffer(5000);
    for (let t = 0; t < 5000; t += 500) ring.push(frame(t));
    expect(ring.length).toBe(10);
    ring.setMaxAge(1000);
    expect(ring.length).toBe(3); // 3500, 4000, 4500
    expect(ring.byteLength).toBe(30);
    ring.setMaxAge(5000);
    expect(ring.length).toBe(3);
  });

  it('slice is inclusive and order-insensitive; nearest picks the closest', () => {
    const ring = new FrameRingBuffer(10_000);
    for (let t = 0; t <= 1000; t += 100) ring.push(frame(t));
    expect(ring.slice(250, 500).map((f) => f.wallTimeMs)).toEqual([300, 400, 500]);
    expect(ring.slice(500, 250).map((f) => f.wallTimeMs)).toEqual([300, 400, 500]);
    expect(ring.slice(5000, 6000)).toEqual([]);
    expect(ring.nearest(240)!.wallTimeMs).toBe(200);
    expect(ring.nearest(260)!.wallTimeMs).toBe(300);
    expect(ring.nearest(-50)!.wallTimeMs).toBe(0);
    expect(ring.nearest(99_999)!.wallTimeMs).toBe(1000);
  });

  it('handles empty buffers', () => {
    const ring = new FrameRingBuffer(1000);
    expect(ring.nearest(0)).toBeNull();
    expect(ring.latest()).toBeNull();
    expect(ring.startMs()).toBeNull();
    expect(ring.slice(0, 10)).toEqual([]);
    expect(ring.all()).toEqual([]);
    ring.push(frame(5));
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.byteLength).toBe(0);
  });

  it('keeps entries sorted when a frame arrives out of order', () => {
    const ring = new FrameRingBuffer(10_000);
    ring.push(frame(100));
    ring.push(frame(300));
    ring.push(frame(200));
    expect(ring.all().map((f) => f.wallTimeMs)).toEqual([100, 200, 300]);
  });
});

describe('frameIndexForTime', () => {
  const frames = [0, 100, 200, 300].map((t) => ({ wallTimeMs: t }));
  it('returns the nearest index, preferring the earlier frame on ties', () => {
    expect(frameIndexForTime(frames, -10)).toBe(0);
    expect(frameIndexForTime(frames, 0)).toBe(0);
    expect(frameIndexForTime(frames, 149)).toBe(1);
    expect(frameIndexForTime(frames, 150)).toBe(1);
    expect(frameIndexForTime(frames, 151)).toBe(2);
    expect(frameIndexForTime(frames, 1000)).toBe(3);
    expect(frameIndexForTime([], 5)).toBe(-1);
  });
});
