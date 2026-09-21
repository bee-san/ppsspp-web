/**
 * Pure PCM helpers for the MP3 encoder (no DOM, no worker): Float32 → Int16
 * conversion, chunking and the lamejs encode loop. Kept separate from the
 * worker so they can be unit-tested in node.
 */
import { Mp3Encoder } from '@breezystack/lamejs';

/** lamejs consumes 1152-sample granules; larger multiples reduce call overhead. */
export const MP3_CHUNK_FRAMES = 1152 * 8;

/** Convert a Float32 [-1, 1] channel to Int16 with clamping (round-to-nearest). */
export function floatToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let v = src[i];
    if (v !== v) v = 0; // NaN
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

/** Down-mix planar channels to mono or keep two channels; returns 1 or 2 Int16 channels. */
export function toEncoderChannels(planar: readonly Float32Array[]): Int16Array[] {
  if (planar.length === 0) return [new Int16Array(0)];
  if (planar.length === 1) return [floatToInt16(planar[0])];
  if (planar.length === 2) return [floatToInt16(planar[0]), floatToInt16(planar[1])];
  // >2 channels: average the extra ones into L/R.
  const n = planar[0].length;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const half = planar.length / 2;
  for (let c = 0; c < planar.length; c++) {
    const dst = c < half ? l : r;
    const src = planar[c];
    for (let i = 0; i < n; i++) dst[i] += src[i] / half;
  }
  return [floatToInt16(l), floatToInt16(r)];
}

/** Split [0, length) into [start, end) ranges of at most `chunk` frames. */
export function chunkRanges(length: number, chunk = MP3_CHUNK_FRAMES): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = 0; s < length; s += chunk) out.push([s, Math.min(length, s + chunk)]);
  return out;
}

export interface Mp3EncodeOptions {
  sampleRate: number;
  kbps: number;
  onProgress?: (done: number, total: number) => void;
}

/** Encode planar PCM to MP3 bytes. Runs synchronously; call from a worker for long clips. */
export function encodeMp3(planar: readonly Float32Array[], opts: Mp3EncodeOptions): Uint8Array<ArrayBuffer> {
  const ch = toEncoderChannels(planar);
  const n = ch[0].length;
  const enc = new Mp3Encoder(ch.length, opts.sampleRate, opts.kbps);
  const parts: Uint8Array[] = [];
  let bytes = 0;
  const ranges = chunkRanges(n);
  for (let k = 0; k < ranges.length; k++) {
    const [s, e] = ranges[k];
    const out = ch.length === 2 ? enc.encodeBuffer(ch[0].subarray(s, e), ch[1].subarray(s, e)) : enc.encodeBuffer(ch[0].subarray(s, e));
    if (out.length) {
      parts.push(out);
      bytes += out.length;
    }
    opts.onProgress?.(e, n);
  }
  const tail = enc.flush();
  if (tail.length) {
    parts.push(tail);
    bytes += tail.length;
  }
  const all = new Uint8Array(bytes);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
}

/** True when `bytes[o..]` starts with an MPEG audio frame sync (11 set bits). */
export function hasMp3FrameSync(bytes: Uint8Array, o = 0): boolean {
  return bytes.length >= o + 2 && bytes[o] === 0xff && (bytes[o + 1] & 0xe0) === 0xe0;
}
