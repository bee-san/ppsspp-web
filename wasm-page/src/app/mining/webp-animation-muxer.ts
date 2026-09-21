/**
 * Animated WebP muxer: wraps already-encoded still WebP frames into one
 * animated container (VP8X + ANIM + ANMF…). No pixel work; O(bytes).
 *
 * Layout (https://developers.google.com/speed/webp/docs/riff_container):
 *   RIFF 'WEBP'
 *     VP8X  flags(1) reserved(3) canvasW-1(3) canvasH-1(3)
 *     ANIM  bgColor BGRA(4) loopCount(2)
 *     ANMF  x/2(3) y/2(3) w-1(3) h-1(3) duration(3) flags(1) [ALPH] VP8|VP8L
 *     ...
 */
import { chunkBytes, concatBytes, parseWebp, riffWebp, u24le, type ParsedWebp } from './webp-riff';

export interface AnimatedFrameInput {
  /** Encoded still WebP bytes. */
  bytes: Uint8Array;
  /** Display duration in ms (1..16_777_215). */
  durationMs: number;
}

export interface AnimatedWebpOptions {
  /** 0 = loop forever. */
  loopCount?: number;
  /** Background as [r, g, b, a]; defaults to opaque black. */
  background?: [number, number, number, number];
}

export const VP8X_FLAG_ANIMATION = 0x02;
export const VP8X_FLAG_ALPHA = 0x10;

/**
 * Turn timestamps into per-frame durations: gap to the next frame; the last
 * frame gets `lastDurationMs` (default: the median gap, or 100 ms). Durations are
 * clamped to ≥ 10 ms because browsers treat very small values like GIF's 0.
 */
export function durationsFromTimestamps(timesMs: readonly number[], lastDurationMs?: number): number[] {
  const n = timesMs.length;
  if (n === 0) return [];
  const gaps: number[] = [];
  for (let i = 0; i + 1 < n; i++) gaps.push(Math.max(10, Math.round(timesMs[i + 1] - timesMs[i])));
  let last = lastDurationMs;
  if (last === undefined) {
    if (gaps.length === 0) last = 100;
    else {
      const sorted = gaps.slice().sort((a, b) => a - b);
      last = sorted[sorted.length >> 1];
    }
  }
  gaps.push(Math.max(10, Math.round(last)));
  return gaps;
}

export function buildAnmf(frame: ParsedWebp, durationMs: number): Uint8Array {
  const dur = Math.min(0xffffff, Math.max(1, Math.round(durationMs)));
  const header = concatBytes([
    u24le(0), // x / 2
    u24le(0), // y / 2
    u24le(frame.width - 1),
    u24le(frame.height - 1),
    u24le(dur),
    // reserved(6) | blending method (1 = do not blend) | disposal (0 = keep)
    new Uint8Array([frame.hasAlpha ? 0x00 : 0x02]),
  ]);
  const parts: Uint8Array[] = [header];
  if (frame.alpha) parts.push(chunkBytes('ALPH', frame.alpha.data));
  parts.push(chunkBytes(frame.bitstream.fourcc, frame.bitstream.data));
  return chunkBytes('ANMF', concatBytes(parts));
}

export function buildVp8x(width: number, height: number, flags: number): Uint8Array {
  return chunkBytes('VP8X', concatBytes([new Uint8Array([flags & 0xff, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]));
}

export function buildAnim(background: [number, number, number, number], loopCount: number): Uint8Array {
  const [r, g, b, a] = background;
  const loop = Math.min(0xffff, Math.max(0, loopCount | 0));
  return chunkBytes('ANIM', new Uint8Array([b & 0xff, g & 0xff, r & 0xff, a & 0xff, loop & 0xff, (loop >>> 8) & 0xff]));
}

/** Mux still frames into one animated WebP. Throws when a frame is not a still WebP. */
export function muxAnimatedWebp(frames: readonly AnimatedFrameInput[], opts: AnimatedWebpOptions = {}): Uint8Array<ArrayBuffer> {
  if (frames.length === 0) throw new Error('no frames');
  const parsed = frames.map((f) => parseWebp(f.bytes));
  let width = 0;
  let height = 0;
  let anyAlpha = false;
  for (const p of parsed) {
    width = Math.max(width, p.width);
    height = Math.max(height, p.height);
    anyAlpha = anyAlpha || p.hasAlpha;
  }
  const chunks: Uint8Array[] = [
    buildVp8x(width, height, VP8X_FLAG_ANIMATION | (anyAlpha ? VP8X_FLAG_ALPHA : 0)),
    buildAnim(opts.background ?? [0, 0, 0, 255], opts.loopCount ?? 0),
  ];
  for (let i = 0; i < parsed.length; i++) chunks.push(buildAnmf(parsed[i], frames[i].durationMs));
  return riffWebp(chunks);
}

/** Convenience: frames with wall-clock timestamps → animated WebP. */
export function muxTimedFrames(frames: readonly { bytes: Uint8Array; wallTimeMs: number }[], opts: AnimatedWebpOptions & { lastDurationMs?: number } = {}): Uint8Array<ArrayBuffer> {
  const durations = durationsFromTimestamps(
    frames.map((f) => f.wallTimeMs),
    opts.lastDurationMs,
  );
  return muxAnimatedWebp(
    frames.map((f, i) => ({ bytes: f.bytes, durationMs: durations[i] })),
    opts,
  );
}
