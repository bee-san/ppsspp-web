/**
 * Pure helpers for the mining picker (trim handles, ranges, formatting).
 * No DOM so they can be unit-tested in node.
 */

export interface TimeRange {
  fromMs: number;
  toMs: number;
}

/** Minimum clip length the picker allows. */
export const MIN_CLIP_MS = 250;

/** Clamp a range into [minMs, maxMs] keeping at least MIN_CLIP_MS (when the window allows). */
export function clampRange(r: TimeRange, minMs: number, maxMs: number, minLenMs = MIN_CLIP_MS): TimeRange {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  const len = Math.min(minLenMs, hi - lo);
  let from = Math.max(lo, Math.min(hi, Math.min(r.fromMs, r.toMs)));
  let to = Math.max(lo, Math.min(hi, Math.max(r.fromMs, r.toMs)));
  if (to - from < len) {
    // Grow toward the side that has room.
    to = Math.min(hi, from + len);
    from = Math.max(lo, to - len);
  }
  return { fromMs: from, toMs: to };
}

/** Initial selection: the last `clipMs` ending at `endMs`, within the buffered window. */
export function defaultRange(startMs: number, endMs: number, clipMs: number): TimeRange {
  return clampRange({ fromMs: endMs - clipMs, toMs: endMs }, startMs, endMs);
}

/** Pixel x within a waveform of `width` px → wall-clock ms. */
export function xToMs(x: number, width: number, startMs: number, endMs: number): number {
  if (width <= 0) return startMs;
  const t = Math.max(0, Math.min(1, x / width));
  return startMs + t * (endMs - startMs);
}

/** Wall-clock ms → pixel x. */
export function msToX(ms: number, width: number, startMs: number, endMs: number): number {
  const span = endMs - startMs;
  if (span <= 0) return 0;
  return ((ms - startMs) / span) * width;
}

/**
 * Apply a handle drag. `handle` is which edge moves ('in' | 'out' | 'both' for
 * moving the whole selection). Enforces order and the minimum length.
 */
export function dragHandle(range: TimeRange, handle: 'in' | 'out' | 'both', deltaMs: number, minMs: number, maxMs: number, minLenMs = MIN_CLIP_MS): TimeRange {
  if (handle === 'both') {
    const len = range.toMs - range.fromMs;
    let from = range.fromMs + deltaMs;
    from = Math.max(minMs, Math.min(maxMs - len, from));
    return { fromMs: from, toMs: from + len };
  }
  if (handle === 'in') {
    const from = Math.max(minMs, Math.min(range.toMs - minLenMs, range.fromMs + deltaMs));
    return clampRange({ fromMs: from, toMs: range.toMs }, minMs, maxMs, minLenMs);
  }
  const to = Math.min(maxMs, Math.max(range.fromMs + minLenMs, range.toMs + deltaMs));
  return clampRange({ fromMs: range.fromMs, toMs: to }, minMs, maxMs, minLenMs);
}

/** Which handle is closest to pixel `x` (within `grabPx`), or 'both' when inside the range, else null. */
export function hitHandle(x: number, range: TimeRange, width: number, startMs: number, endMs: number, grabPx = 22): 'in' | 'out' | 'both' | null {
  const xi = msToX(range.fromMs, width, startMs, endMs);
  const xo = msToX(range.toMs, width, startMs, endMs);
  const di = Math.abs(x - xi);
  const dob = Math.abs(x - xo);
  if (di <= grabPx || dob <= grabPx) return di <= dob ? 'in' : 'out';
  if (x > xi && x < xo) return 'both';
  return null;
}

/** "3.2 s" / "12.0 s" style label. */
export function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** Relative "−4.5 s" offset from the end of the buffer. */
export function formatOffset(ms: number, endMs: number): string {
  const d = (ms - endMs) / 1000;
  return `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)} s`;
}
