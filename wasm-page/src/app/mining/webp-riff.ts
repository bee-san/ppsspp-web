/**
 * Minimal RIFF/WebP container reader + writer helpers.
 *
 * Still WebP produced by `canvas.toBlob('image/webp')` is one of:
 *   RIFF 'WEBP' [ 'VP8 ' ]                       (lossy, simple)
 *   RIFF 'WEBP' [ 'VP8L' ]                       (lossless, simple)
 *   RIFF 'WEBP' [ 'VP8X' ('ICCP')? ('ALPH')? ('VP8 '|'VP8L') ... ]  (extended)
 * The parser extracts the bitstream chunk (+ optional ALPH) and the canvas size
 * so frames can be re-wrapped into an animated container without re-encoding.
 */

export interface RiffChunk {
  fourcc: string;
  /** Payload without the header and without the padding byte. */
  data: Uint8Array;
}

export interface ParsedWebp {
  width: number;
  height: number;
  /** 'VP8 ' or 'VP8L' chunk. */
  bitstream: RiffChunk;
  alpha: RiffChunk | null;
  hasAlpha: boolean;
}

const ASCII = new TextDecoder('ascii');

export function fourcc(s: string): Uint8Array {
  if (s.length !== 4) throw new Error(`fourcc must be 4 chars: ${JSON.stringify(s)}`);
  return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}

export function u32le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

export function u24le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff]);
}

function readU32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function readU24le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
}

/** Iterate the chunks of a RIFF payload (after the 12-byte RIFF header). */
export function* iterChunks(bytes: Uint8Array, start = 12, end = bytes.length): Generator<RiffChunk> {
  let o = start;
  while (o + 8 <= end) {
    const cc = ASCII.decode(bytes.subarray(o, o + 4));
    const size = readU32le(bytes, o + 4);
    const dataStart = o + 8;
    const dataEnd = Math.min(end, dataStart + size);
    yield { fourcc: cc, data: bytes.subarray(dataStart, dataEnd) };
    o = dataStart + size + (size & 1);
  }
}

/** Serialize one chunk: fourcc + le32 size + payload + pad to even. */
export function chunkBytes(cc: string, payload: Uint8Array): Uint8Array {
  const padded = payload.length + (payload.length & 1);
  const out = new Uint8Array(8 + padded);
  out.set(fourcc(cc), 0);
  out.set(u32le(payload.length), 4);
  out.set(payload, 8);
  return out;
}

export function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ASCII.decode(bytes.subarray(0, 4)) === 'RIFF' && ASCII.decode(bytes.subarray(8, 12)) === 'WEBP';
}

/** Canvas size from a 'VP8 ' (lossy) frame header. */
export function vp8Size(data: Uint8Array): { width: number; height: number } | null {
  // 3-byte frame tag, then start code 9d 01 2a, then 14-bit width / 14-bit height (+2-bit scale each).
  if (data.length < 10) return null;
  const keyFrame = (data[0] & 1) === 0;
  if (!keyFrame || data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) return null;
  const width = (data[6] | (data[7] << 8)) & 0x3fff;
  const height = (data[8] | (data[9] << 8)) & 0x3fff;
  return { width, height };
}

/** Canvas size + alpha flag from a 'VP8L' (lossless) header. */
export function vp8lSize(data: Uint8Array): { width: number; height: number; alpha: boolean } | null {
  if (data.length < 5 || data[0] !== 0x2f) return null;
  const bits = readU32le(data, 1);
  const width = (bits & 0x3fff) + 1;
  const height = ((bits >>> 14) & 0x3fff) + 1;
  const alpha = ((bits >>> 28) & 1) === 1;
  return { width, height, alpha };
}

/** Canvas size from a 'VP8X' header (24-bit width-1 / height-1 at offsets 4 and 7). */
export function vp8xSize(data: Uint8Array): { width: number; height: number; flags: number } | null {
  if (data.length < 10) return null;
  return { flags: data[0], width: readU24le(data, 4) + 1, height: readU24le(data, 7) + 1 };
}

/** Parse a still WebP file. Throws on malformed input or animated files. */
export function parseWebp(bytes: Uint8Array): ParsedWebp {
  if (!isWebp(bytes)) throw new Error('not a WebP file');
  const riffSize = readU32le(bytes, 4);
  const end = Math.min(bytes.length, 8 + riffSize);
  let vp8x: { width: number; height: number; flags: number } | null = null;
  let alpha: RiffChunk | null = null;
  let bitstream: RiffChunk | null = null;
  for (const c of iterChunks(bytes, 12, end)) {
    if (c.fourcc === 'VP8X') vp8x = vp8xSize(c.data);
    else if (c.fourcc === 'ALPH') alpha = { fourcc: 'ALPH', data: c.data.slice() };
    else if (c.fourcc === 'VP8 ' || c.fourcc === 'VP8L') {
      bitstream = { fourcc: c.fourcc, data: c.data.slice() };
      break;
    } else if (c.fourcc === 'ANIM' || c.fourcc === 'ANMF') throw new Error('animated WebP cannot be used as a frame');
  }
  if (!bitstream) throw new Error('WebP has no VP8/VP8L bitstream');
  let width = 0;
  let height = 0;
  let hasAlpha = !!alpha;
  if (bitstream.fourcc === 'VP8L') {
    const s = vp8lSize(bitstream.data);
    if (!s) throw new Error('bad VP8L header');
    width = s.width;
    height = s.height;
    hasAlpha = hasAlpha || s.alpha;
  } else {
    const s = vp8Size(bitstream.data);
    if (!s) throw new Error('bad VP8 header');
    width = s.width;
    height = s.height;
  }
  if (vp8x) {
    // The extended header is authoritative for the canvas size (frames may be padded).
    width = vp8x.width;
    height = vp8x.height;
    hasAlpha = hasAlpha || (vp8x.flags & 0x10) !== 0;
  }
  return { width, height, bitstream, alpha, hasAlpha };
}

/** Concatenate byte arrays. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Wrap chunks into a complete RIFF/WEBP file (fixes up the RIFF size). */
export function riffWebp(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concatBytes(chunks);
  const out = new Uint8Array(12 + body.length);
  out.set(fourcc('RIFF'), 0);
  out.set(u32le(4 + body.length), 4);
  out.set(fourcc('WEBP'), 8);
  out.set(body, 12);
  return out;
}
