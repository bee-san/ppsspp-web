import { describe, expect, it } from 'vitest';
import { chunkRanges, encodeMp3, floatToInt16, hasMp3FrameSync, MP3_CHUNK_FRAMES, toEncoderChannels } from './mp3-pcm';

describe('mp3 pcm helpers', () => {
  it('converts float to int16 with clamping and NaN → 0', () => {
    const out = floatToInt16(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2, NaN]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 16384, -16384, 32767, -32768, 0]);
  });

  it('maps 1/2/N channels to 1 or 2 encoder channels', () => {
    expect(toEncoderChannels([]).length).toBe(1);
    expect(toEncoderChannels([new Float32Array([0.5])]).length).toBe(1);
    const st = toEncoderChannels([new Float32Array([0.5]), new Float32Array([-0.5])]);
    expect(st.length).toBe(2);
    expect(st[0][0]).toBe(16384);
    expect(st[1][0]).toBe(-16384);
    // 4 channels: [a, b] → L, [c, d] → R, averaged.
    const quad = toEncoderChannels([new Float32Array([1]), new Float32Array([0]), new Float32Array([-1]), new Float32Array([-1])]);
    expect(quad[0][0]).toBe(16384);
    expect(quad[1][0]).toBe(-32768);
  });

  it('chunks into ≤ MP3_CHUNK_FRAMES ranges covering the input exactly', () => {
    expect(chunkRanges(0)).toEqual([]);
    expect(chunkRanges(10, 4)).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
    const r = chunkRanges(MP3_CHUNK_FRAMES * 2 + 1);
    expect(r.length).toBe(3);
    expect(r[2]).toEqual([MP3_CHUNK_FRAMES * 2, MP3_CHUNK_FRAMES * 2 + 1]);
  });

  it('encodes a 0.5 s stereo sine to a valid, non-trivial MP3 via lamejs', () => {
    const sr = 44_100;
    const n = sr / 2;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      l[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
      r[i] = 0.5 * Math.sin((2 * Math.PI * 660 * i) / sr);
    }
    const progress: number[] = [];
    const mp3 = encodeMp3([l, r], { sampleRate: sr, kbps: 96, onProgress: (d, t) => progress.push(d / t) });
    expect(hasMp3FrameSync(mp3)).toBe(true);
    // 96 kbps × 0.5 s ≈ 6000 bytes; lamejs pads a little. Accept a generous window.
    expect(mp3.length).toBeGreaterThan(4000);
    expect(mp3.length).toBeLessThan(12_000);
    expect(progress[progress.length - 1]).toBe(1);
    // Count frame syncs: 1152 samples/frame → ~19 frames for 0.5 s.
    let frames = 0;
    for (let i = 0; i + 1 < mp3.length; i++) if (mp3[i] === 0xff && (mp3[i + 1] & 0xe0) === 0xe0) frames++;
    expect(frames).toBeGreaterThanOrEqual(15);
  });

  it('encodes mono input too', () => {
    const mp3 = encodeMp3([new Float32Array(2304)], { sampleRate: 22_050, kbps: 64 });
    expect(hasMp3FrameSync(mp3)).toBe(true);
    expect(mp3.length).toBeGreaterThan(100);
  });
});
