import { describe, expect, it } from 'vitest';
import { buildAnmf, durationsFromTimestamps, muxAnimatedWebp, muxTimedFrames, VP8X_FLAG_ALPHA, VP8X_FLAG_ANIMATION } from './webp-animation-muxer';
import { chunkBytes, isWebp, iterChunks, parseWebp, riffWebp, vp8Size, vp8lSize, vp8xSize } from './webp-riff';

const ascii = (b: Uint8Array) => String.fromCharCode(...b);
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le24 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

/** Synthetic lossy bitstream: keyframe tag, start code, dimensions, then `payload` filler bytes. */
function fakeVp8(width: number, height: number, payload = 7): Uint8Array {
  const out = new Uint8Array(10 + payload);
  out[0] = 0x10; // key frame (bit 0 = 0), version 0, show_frame
  out[1] = 0x02;
  out[2] = 0x00;
  out[3] = 0x9d;
  out[4] = 0x01;
  out[5] = 0x2a;
  out[6] = width & 0xff;
  out[7] = (width >> 8) & 0x3f;
  out[8] = height & 0xff;
  out[9] = (height >> 8) & 0x3f;
  for (let i = 10; i < out.length; i++) out[i] = 0xa0 + i;
  return out;
}

/** Synthetic lossless bitstream: signature + 14/14-bit size + alpha flag. */
function fakeVp8l(width: number, height: number, alpha: boolean, payload = 4): Uint8Array {
  const out = new Uint8Array(5 + payload);
  out[0] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  out[1] = bits & 0xff;
  out[2] = (bits >>> 8) & 0xff;
  out[3] = (bits >>> 16) & 0xff;
  out[4] = (bits >>> 24) & 0xff;
  for (let i = 5; i < out.length; i++) out[i] = 0x50 + i;
  return out;
}

const simpleLossy = (w: number, h: number, payload?: number) => riffWebp([chunkBytes('VP8 ', fakeVp8(w, h, payload))]);
const simpleLossless = (w: number, h: number, alpha = false) => riffWebp([chunkBytes('VP8L', fakeVp8l(w, h, alpha))]);
function extendedWithAlpha(w: number, h: number): Uint8Array {
  const vp8x = new Uint8Array(10);
  vp8x[0] = VP8X_FLAG_ALPHA;
  vp8x[4] = (w - 1) & 0xff;
  vp8x[5] = ((w - 1) >> 8) & 0xff;
  vp8x[6] = ((w - 1) >> 16) & 0xff;
  vp8x[7] = (h - 1) & 0xff;
  vp8x[8] = ((h - 1) >> 8) & 0xff;
  vp8x[9] = ((h - 1) >> 16) & 0xff;
  return riffWebp([chunkBytes('VP8X', vp8x), chunkBytes('ICCP', new Uint8Array([1, 2, 3])), chunkBytes('ALPH', new Uint8Array([9, 9, 9, 9, 9])), chunkBytes('VP8 ', fakeVp8(w, h))]);
}

describe('webp-riff', () => {
  it('parses simple lossy, simple lossless and extended files', () => {
    const lossy = parseWebp(simpleLossy(320, 180));
    expect(lossy.width).toBe(320);
    expect(lossy.height).toBe(180);
    expect(lossy.bitstream.fourcc).toBe('VP8 ');
    expect(lossy.alpha).toBeNull();
    expect(lossy.hasAlpha).toBe(false);

    const lossless = parseWebp(simpleLossless(64, 48, true));
    expect(lossless.width).toBe(64);
    expect(lossless.height).toBe(48);
    expect(lossless.bitstream.fourcc).toBe('VP8L');
    expect(lossless.hasAlpha).toBe(true);

    const ext = parseWebp(extendedWithAlpha(480, 272));
    expect(ext.width).toBe(480);
    expect(ext.height).toBe(272);
    expect(ext.alpha?.data.length).toBe(5);
    expect(ext.hasAlpha).toBe(true);
    expect(ext.bitstream.fourcc).toBe('VP8 ');
  });

  it('pads odd-sized chunks and iterates past them', () => {
    const odd = chunkBytes('ICCP', new Uint8Array([1, 2, 3]));
    expect(odd.length).toBe(8 + 4);
    expect(le32(odd, 4)).toBe(3);
    const file = riffWebp([odd, chunkBytes('VP8 ', fakeVp8(16, 16, 8))]);
    expect(isWebp(file)).toBe(true);
    expect(le32(file, 4)).toBe(file.length - 8);
    expect([...iterChunks(file)].map((c) => c.fourcc)).toEqual(['ICCP', 'VP8 ']);
  });

  it('rejects non-WebP, animated and truncated input', () => {
    expect(() => parseWebp(new Uint8Array(20))).toThrow(/not a WebP/);
    expect(() => parseWebp(riffWebp([chunkBytes('ANIM', new Uint8Array(6))]))).toThrow(/animated/);
    expect(() => parseWebp(riffWebp([chunkBytes('EXIF', new Uint8Array(2))]))).toThrow(/no VP8/);
    expect(vp8Size(new Uint8Array(3))).toBeNull();
    expect(vp8lSize(new Uint8Array([0x00, 1, 2, 3, 4]))).toBeNull();
    expect(vp8xSize(new Uint8Array(4))).toBeNull();
  });
});

describe('durationsFromTimestamps', () => {
  it('uses the gap to the next frame and the median gap for the last frame', () => {
    expect(durationsFromTimestamps([0, 125, 250, 375])).toEqual([125, 125, 125, 125]);
    expect(durationsFromTimestamps([0, 100, 300])).toEqual([100, 200, 200]);
    expect(durationsFromTimestamps([0, 100, 300], 40)).toEqual([100, 200, 40]);
    expect(durationsFromTimestamps([5])).toEqual([100]);
    expect(durationsFromTimestamps([])).toEqual([]);
    // Clamp tiny/negative gaps.
    expect(durationsFromTimestamps([0, 1, 0])).toEqual([10, 10, 10]);
  });
});

describe('muxAnimatedWebp', () => {
  it('emits VP8X + ANIM + one ANMF per frame with correct sizes and durations', () => {
    const frames = [
      { bytes: simpleLossy(320, 180, 7), durationMs: 125 },
      { bytes: simpleLossy(320, 180, 8), durationMs: 130 },
      { bytes: simpleLossless(320, 180, false), durationMs: 200 },
    ];
    const out = muxAnimatedWebp(frames, { loopCount: 0, background: [1, 2, 3, 255] });
    expect(isWebp(out)).toBe(true);
    expect(out.length % 2).toBe(0);
    expect(le32(out, 4)).toBe(out.length - 8);

    const chunks = [...iterChunks(out)];
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF', 'ANMF']);

    const vp8x = chunks[0].data;
    expect(vp8x.length).toBe(10);
    expect(vp8x[0] & VP8X_FLAG_ANIMATION).toBe(VP8X_FLAG_ANIMATION);
    expect(vp8x[0] & VP8X_FLAG_ALPHA).toBe(0);
    expect(le24(vp8x, 4) + 1).toBe(320);
    expect(le24(vp8x, 7) + 1).toBe(180);

    const anim = chunks[1].data;
    expect(anim.length).toBe(6);
    expect(Array.from(anim.subarray(0, 4))).toEqual([3, 2, 1, 255]); // BGRA
    expect(anim[4] | (anim[5] << 8)).toBe(0);

    const durations = chunks.slice(2).map((c) => le24(c.data, 12));
    expect(durations).toEqual([125, 130, 200]);
    for (const c of chunks.slice(2)) {
      expect(le24(c.data, 0)).toBe(0); // x
      expect(le24(c.data, 3)).toBe(0); // y
      expect(le24(c.data, 6) + 1).toBe(320);
      expect(le24(c.data, 9) + 1).toBe(180);
      expect(c.data[15]).toBe(0x02); // no alpha → do-not-blend, keep
    }
    // Frame data chunk inside the first ANMF is the original VP8 payload, byte for byte.
    const inner = [...iterChunks(chunks[2].data, 16, chunks[2].data.length)];
    expect(inner.map((c) => c.fourcc)).toEqual(['VP8 ']);
    expect(Array.from(inner[0].data)).toEqual(Array.from(fakeVp8(320, 180, 7)));
    const inner3 = [...iterChunks(chunks[4].data, 16, chunks[4].data.length)];
    expect(inner3[0].fourcc).toBe('VP8L');
  });

  it('carries ALPH chunks and sets the alpha flag when any frame has alpha', () => {
    const out = muxAnimatedWebp([
      { bytes: extendedWithAlpha(480, 272), durationMs: 100 },
      { bytes: simpleLossy(480, 272), durationMs: 100 },
    ]);
    const chunks = [...iterChunks(out)];
    expect(chunks[0].data[0] & VP8X_FLAG_ALPHA).toBe(VP8X_FLAG_ALPHA);
    const inner = [...iterChunks(chunks[2].data, 16, chunks[2].data.length)];
    expect(inner.map((c) => c.fourcc)).toEqual(['ALPH', 'VP8 ']);
    expect(chunks[2].data[15]).toBe(0x00); // alpha → blend
    // ICCP from the source still is dropped; only ALPH + bitstream are kept.
    expect(inner.some((c) => c.fourcc === 'ICCP')).toBe(false);
  });

  it('uses the largest frame as the canvas and clamps durations', () => {
    const out = muxAnimatedWebp([
      { bytes: simpleLossy(100, 50), durationMs: 0 },
      { bytes: simpleLossy(120, 40), durationMs: 99_999_999 },
    ]);
    const chunks = [...iterChunks(out)];
    expect(le24(chunks[0].data, 4) + 1).toBe(120);
    expect(le24(chunks[0].data, 7) + 1).toBe(50);
    expect(le24(chunks[2].data, 12)).toBe(1);
    expect(le24(chunks[3].data, 12)).toBe(0xffffff);
    expect(le24(chunks[3].data, 6) + 1).toBe(120);
    expect(le24(chunks[3].data, 9) + 1).toBe(40);
  });

  it('muxTimedFrames derives durations from wall-clock timestamps', () => {
    const out = muxTimedFrames([
      { bytes: simpleLossy(8, 8), wallTimeMs: 1000 },
      { bytes: simpleLossy(8, 8), wallTimeMs: 1120 },
      { bytes: simpleLossy(8, 8), wallTimeMs: 1250 },
    ]);
    const durations = [...iterChunks(out)].slice(2).map((c) => le24(c.data, 12));
    expect(durations).toEqual([120, 130, 130]);
  });

  it('rejects empty input and non-WebP frames', () => {
    expect(() => muxAnimatedWebp([])).toThrow(/no frames/);
    expect(() => muxAnimatedWebp([{ bytes: new Uint8Array(30), durationMs: 10 }])).toThrow(/not a WebP/);
    expect(ascii(buildAnmf(parseWebp(simpleLossy(8, 8)), 10).subarray(0, 4))).toBe('ANMF');
  });
});
