import { describe, expect, it } from 'vitest';
import { AudioRingBuffer, peaks, subSlice } from './audio-ring-buffer';
import type { AudioTapChunk } from './mining-types';

const SR = 1000; // 1 kHz keeps the maths readable: 1 frame = 1 ms

/** Planar chunk whose left channel is the absolute frame index (as a float) and right is negative. */
function planar(startFrame: number, frames: number, wallTimeMs: number, sampleRate = SR): AudioTapChunk {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    l[i] = startFrame + i;
    r[i] = -(startFrame + i);
  }
  return { channels: [l, r], frames, sampleRate, wallTimeMs };
}

function interleaved(startFrame: number, frames: number, wallTimeMs: number, sampleRate = SR): AudioTapChunk {
  const buf = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    buf[i * 2] = startFrame + i;
    buf[i * 2 + 1] = -(startFrame + i);
  }
  return { interleaved: buf, channelCount: 2, frames, sampleRate, wallTimeMs };
}

/** Feed `chunks` × `size` frames starting at wall time t0, one chunk per `size` ms (perfect clock). */
function fill(ring: AudioRingBuffer, chunks: number, size: number, t0 = 10_000, fmt: 'planar' | 'interleaved' = 'planar'): void {
  for (let k = 0; k < chunks; k++) {
    const start = k * size;
    ring.push(fmt === 'planar' ? planar(start, size, t0 + start) : interleaved(start, size, t0 + start));
  }
}

describe('AudioRingBuffer', () => {
  it('reports capacity and availability', () => {
    const ring = new AudioRingBuffer(2, SR, 2);
    expect(ring.seconds).toBe(2);
    expect(ring.available()).toBe(0);
    expect(ring.startMs()).toBeNull();
    fill(ring, 3, 100);
    expect(ring.available()).toBe(300);
    expect(ring.availableMs()).toBe(300);
    fill(ring, 30, 100);
    expect(ring.available()).toBe(2000);
  });

  it('keeps only the newest frames across wraparound', () => {
    const ring = new AudioRingBuffer(1, SR, 2); // 1000 frames
    fill(ring, 25, 100); // 2500 frames written → keeps 1500..2499
    const all = ring.sliceAll()!;
    expect(all.channels[0].length).toBe(1000);
    expect(all.channels[0][0]).toBe(1500);
    expect(all.channels[0][999]).toBe(2499);
    expect(all.channels[1][0]).toBe(-1500);
    expect(all.startMs).toBe(10_000 + 1500);
    expect(all.durationMs).toBe(1000);
  });

  it('slices across the wrap boundary by wall-clock', () => {
    const ring = new AudioRingBuffer(1, SR, 2);
    fill(ring, 25, 100); // wall 10000..12500 ; retained 11500..12500
    // Ask for 11950..12050 → frames 1950..2050, which straddles index 1000 % 1000 = 0 (wrap at frame 2000).
    const s = ring.slice(11_950, 12_050)!;
    expect(s.channels[0].length).toBe(100);
    expect(s.channels[0][0]).toBe(1950);
    expect(s.channels[0][49]).toBe(1999);
    expect(s.channels[0][50]).toBe(2000);
    expect(s.channels[0][99]).toBe(2049);
    expect(s.startMs).toBe(11_950);
  });

  it('clamps out-of-range requests and returns null for empty ranges', () => {
    const ring = new AudioRingBuffer(1, SR, 2);
    expect(ring.slice(0, 1000)).toBeNull();
    fill(ring, 5, 100); // wall 10000..10500
    const s = ring.slice(0, 99_999)!;
    expect(s.channels[0].length).toBe(500);
    expect(ring.slice(10_600, 10_700)).toBeNull();
    expect(ring.slice(9000, 9500)).toBeNull();
  });

  it('interpolates wall-clock → frame inside jittery chunks', () => {
    const ring = new AudioRingBuffer(2, SR, 2);
    // Chunks of 100 frames delivered with irregular wall times (bursts + gaps).
    ring.push(planar(0, 100, 1000));
    ring.push(planar(100, 100, 1010)); // came early
    ring.push(planar(200, 100, 1300)); // came late
    ring.push(planar(300, 100, 1400));
    // Midway between mark 1 (1010→frame 100) and mark 2 (1300→frame 200): frame 150.
    expect(ring.msToFrame(1155)).toBe(150);
    // Before the first mark: extrapolate → clamped to the oldest frame.
    expect(ring.msToFrame(500)).toBe(0);
    // After the last mark: nominal rate.
    expect(ring.msToFrame(1450)).toBe(350);
    expect(ring.msToFrame(99_999)).toBe(400);
    expect(ring.frameToMs(150)).toBeCloseTo(1010 + 50, 5);
    expect(ring.endMs()).toBeCloseTo(1500, 5);
  });

  it('accepts interleaved chunks and re-configures on a format change', () => {
    const ring = new AudioRingBuffer(1, SR, 2);
    fill(ring, 3, 100, 10_000, 'interleaved');
    const s = ring.sliceAll()!;
    expect(s.channels.length).toBe(2);
    expect(s.channels[0][5]).toBe(5);
    expect(s.channels[1][5]).toBe(-5);
    // Sample-rate change: old data is dropped, capacity follows the new rate.
    ring.push(planar(0, 50, 20_000, 2000));
    expect(ring.rate).toBe(2000);
    expect(ring.available()).toBe(50);
    expect(ring.seconds).toBe(1);
  });

  it('resize keeps the newest audio (shrink) and preserves data (grow)', () => {
    const ring = new AudioRingBuffer(2, SR, 2);
    fill(ring, 15, 100); // 1500 frames, retained 0..1499
    ring.reconfigure(0.5); // keep the last 500 → frames 1000..1499
    expect(ring.available()).toBe(500);
    const s = ring.sliceAll()!;
    expect(s.channels[0][0]).toBe(1000);
    expect(s.channels[0][499]).toBe(1499);
    expect(s.startMs).toBe(11_000);
    // Grow: nothing lost, further pushes continue seamlessly.
    ring.reconfigure(3);
    expect(ring.available()).toBe(500);
    ring.push(planar(1500, 100, 11_500));
    const t = ring.sliceAll()!;
    expect(t.channels[0].length).toBe(600);
    expect(t.channels[0][0]).toBe(1000);
    expect(t.channels[0][599]).toBe(1599);
    // Slicing by time still works across the resized ring.
    expect(ring.slice(11_400, 11_550)!.channels[0][0]).toBe(1400);
  });

  it('clone() is independent and keeps the wall-clock mapping across a production gap', () => {
    const ring = new AudioRingBuffer(2, SR, 2);
    ring.push(planar(0, 100, 1000));
    ring.push(planar(100, 100, 1100));
    // Producer stalled for 300 ms (frames dropped), then resumed: 200 ms of audio spans 500 ms of wall-clock.
    ring.push(planar(200, 100, 1500));
    ring.push(planar(300, 100, 1600));
    const snap = ring.clone();
    ring.push(planar(400, 100, 1700)); // live ring moves on; the clone must not
    expect(snap.available()).toBe(400);
    expect(snap.startMs()).toBe(1000);
    expect(snap.endMs()).toBe(1700);
    // Wall-clock 1500..1600 → frames 200..300 even though "continuous" maths would say 500..600.
    const s = snap.slice(1500, 1600)!;
    expect(s.channels[0][0]).toBe(200);
    expect(s.channels[0].length).toBe(100);
    // Inside the gap the preceding chunk is stretched (interpolation by mark spacing): the
    // range maps to a short piece of that chunk, never to audio produced after the gap.
    const gap = snap.slice(1250, 1450)!;
    expect(gap.channels[0].length).toBeLessThan(100);
    expect(gap.channels[0][0]).toBeGreaterThanOrEqual(100);
    expect(gap.channels[0][gap.channels[0].length - 1]).toBeLessThan(200);
    expect(ring.available()).toBe(500);
  });

  it('peaksByTime maps bins through the marks (gaps stay silent)', () => {
    const ring = new AudioRingBuffer(2, SR, 2);
    const loud = (start: number, frames: number, t: number, amp: number) => {
      const c = planar(start, frames, t) as { channels: Float32Array[] };
      c.channels[0].fill(amp);
      c.channels[1].fill(0);
      return c as never;
    };
    ring.push(loud(0, 100, 1000, 0.2));
    ring.push(loud(100, 100, 1500, 0.9)); // 400 ms gap before this chunk
    const p = ring.peaksByTime(1000, 1600, 6); // 100 ms bins
    expect(p[0]).toBeCloseTo(0.2, 5);
    // Bins inside the gap map onto (at most) the boundary frame between the two chunks.
    expect(p[2]).toBeLessThanOrEqual(0.9);
    expect(p[5]).toBeCloseTo(0.9, 5);
    expect(new AudioRingBuffer(1, SR, 1).peaksByTime(0, 100, 4).length).toBe(4);
  });

  it('clear() empties the ring', () => {
    const ring = new AudioRingBuffer(1, SR, 2);
    fill(ring, 2, 100);
    ring.clear();
    expect(ring.available()).toBe(0);
    expect(ring.sliceAll()).toBeNull();
  });
});

describe('peaks / subSlice', () => {
  it('computes a per-bin max over all channels', () => {
    const l = new Float32Array([0, 0.5, 0, 0, 0, 0, 0.1, 0]);
    const r = new Float32Array([0, 0, 0, -0.9, 0, 0, 0, 0]);
    const p = peaks({ channels: [l, r], sampleRate: 8, startMs: 0, durationMs: 1000 }, 4);
    expect(Array.from(p)).toEqual([0.5, expect.closeTo(0.9, 5), 0, expect.closeTo(0.1, 5)]);
    expect(peaks({ channels: [new Float32Array(0)], sampleRate: 8, startMs: 0, durationMs: 0 }, 3).length).toBe(3);
  });

  it('subSlice cuts by wall-clock relative to the slice start', () => {
    const l = Float32Array.from({ length: 1000 }, (_, i) => i);
    const s = { channels: [l], sampleRate: SR, startMs: 5000, durationMs: 1000 };
    const sub = subSlice(s, 5200, 5300);
    expect(sub.channels[0].length).toBe(100);
    expect(sub.channels[0][0]).toBe(200);
    expect(sub.startMs).toBe(5200);
    expect(sub.durationMs).toBe(100);
    const clamped = subSlice(s, 0, 99_999);
    expect(clamped.channels[0].length).toBe(1000);
    const empty = subSlice(s, 5300, 5300);
    expect(empty.channels[0].length).toBe(0);
  });
});
