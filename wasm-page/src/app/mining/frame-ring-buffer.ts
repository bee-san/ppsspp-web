/**
 * FrameRingBuffer — time-bounded list of already-encoded still frames.
 * Entries older than `maxAgeMs` (relative to the newest entry) are evicted on push.
 */
import type { BufferedFrame } from './mining-types';

export class FrameRingBuffer {
  private items: BufferedFrame[] = [];
  private bytes = 0;

  constructor(private maxAgeMs: number) {}

  setMaxAge(ms: number): void {
    this.maxAgeMs = Math.max(0, ms);
    this.evict();
  }

  get length(): number {
    return this.items.length;
  }

  /** Sum of blob sizes currently retained. */
  get byteLength(): number {
    return this.bytes;
  }

  push(frame: BufferedFrame): void {
    // Keep the list sorted by time; out-of-order pushes are inserted, not appended.
    const last = this.items[this.items.length - 1];
    if (!last || last.wallTimeMs <= frame.wallTimeMs) this.items.push(frame);
    else {
      let i = this.items.length - 1;
      while (i > 0 && this.items[i - 1].wallTimeMs > frame.wallTimeMs) i--;
      this.items.splice(i, 0, frame);
    }
    this.bytes += frame.blob.size;
    this.evict();
  }

  private evict(): void {
    const newest = this.items[this.items.length - 1];
    if (!newest) return;
    const cutoff = newest.wallTimeMs - this.maxAgeMs;
    let drop = 0;
    while (drop < this.items.length - 1 && this.items[drop].wallTimeMs < cutoff) drop++;
    if (drop > 0) {
      for (let i = 0; i < drop; i++) this.bytes -= this.items[i].blob.size;
      this.items.splice(0, drop);
    }
  }

  /** Frames with `fromMs <= wallTimeMs <= toMs`, oldest first. */
  slice(fromMs: number, toMs: number): BufferedFrame[] {
    const a = Math.min(fromMs, toMs);
    const b = Math.max(fromMs, toMs);
    return this.items.filter((f) => f.wallTimeMs >= a && f.wallTimeMs <= b);
  }

  /** Frame whose timestamp is closest to `ms`, or null when empty. */
  nearest(ms: number): BufferedFrame | null {
    let best: BufferedFrame | null = null;
    let bestD = Infinity;
    for (const f of this.items) {
      const d = Math.abs(f.wallTimeMs - ms);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  /** Newest frame or null. */
  latest(): BufferedFrame | null {
    return this.items[this.items.length - 1] ?? null;
  }

  /** Oldest retained timestamp or null. */
  startMs(): number | null {
    return this.items[0]?.wallTimeMs ?? null;
  }

  /** Copy of all retained frames, oldest first. */
  all(): BufferedFrame[] {
    return this.items.slice();
  }

  clear(): void {
    this.items = [];
    this.bytes = 0;
  }
}

/** Index of the frame (in a time-sorted list) nearest to `ms`; -1 when empty. */
export function frameIndexForTime(frames: readonly { wallTimeMs: number }[], ms: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].wallTimeMs < ms) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frames[lo - 1].wallTimeMs - ms) <= Math.abs(frames[lo].wallTimeMs - ms)) return lo - 1;
  return lo;
}
