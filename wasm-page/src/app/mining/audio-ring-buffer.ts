/**
 * AudioRingBuffer — planar Float32 ring holding the last N seconds of game PCM.
 *
 * Wall-clock mapping: each pushed chunk records `(wallTimeMs, cumulativeFrame)`.
 * `slice(fromMs, toMs)` converts wall-clock bounds to frame positions by
 * interpolating inside the chunk that contains them, so gaps/jitter in the
 * producer's timing do not accumulate. Frames older than the capacity are
 * overwritten; the chunk index is pruned accordingly.
 */
import type { AudioTapChunk, PcmSlice } from './mining-types';

interface ChunkMark {
  wallTimeMs: number;
  /** Absolute frame index (monotonic since construction) of the chunk's first frame. */
  cumFrame: number;
  frames: number;
}

export class AudioRingBuffer {
  private channels: Float32Array[] = [];
  private capacity: number;
  private channelCount: number;
  private sampleRate: number;
  /** Absolute number of frames written so far. */
  private written = 0;
  /** Absolute frame index below which nothing is retained (raised when the ring shrinks). */
  private floor = 0;
  private marks: ChunkMark[] = [];

  constructor(seconds: number, sampleRate = 44_100, channelCount = 2) {
    this.sampleRate = Math.max(1, Math.round(sampleRate));
    this.channelCount = Math.max(1, channelCount);
    this.capacity = Math.max(1, Math.round(seconds * this.sampleRate));
    this.allocate();
  }

  private allocate(): void {
    this.channels = Array.from({ length: this.channelCount }, () => new Float32Array(this.capacity));
  }

  get seconds(): number {
    return this.capacity / this.sampleRate;
  }
  get rate(): number {
    return this.sampleRate;
  }
  get channelsCount(): number {
    return this.channelCount;
  }
  get totalFramesWritten(): number {
    return this.written;
  }

  /** Frames currently retained (≤ capacity). */
  available(): number {
    return Math.min(this.written - this.floor, this.capacity);
  }

  availableMs(): number {
    return (this.available() / this.sampleRate) * 1000;
  }

  /** Oldest frame index still in the ring. */
  private oldestFrame(): number {
    return this.written - this.available();
  }

  /** Push a chunk from the bridge tap. Copies synchronously; adapts format/rate on change. */
  push(chunk: AudioTapChunk): void {
    const frames = chunk.frames | 0;
    if (frames <= 0) return;
    const chCount = 'channels' in chunk ? chunk.channels.length : chunk.channelCount;
    if (chunk.sampleRate !== this.sampleRate || chCount !== this.channelCount) {
      // Format change: the old data is not comparable; restart with the new format.
      this.reconfigure(this.seconds, chunk.sampleRate, chCount);
    }
    const start = this.written;
    this.marks.push({ wallTimeMs: chunk.wallTimeMs, cumFrame: start, frames });

    const cap = this.capacity;
    if ('channels' in chunk) {
      for (let c = 0; c < this.channelCount; c++) {
        const src = chunk.channels[c];
        const dst = this.channels[c];
        for (let i = 0; i < frames; i++) dst[(start + i) % cap] = src[i];
      }
    } else {
      const src = chunk.interleaved;
      const n = this.channelCount;
      for (let i = 0; i < frames; i++) {
        const w = (start + i) % cap;
        for (let c = 0; c < n; c++) this.channels[c][w] = src[i * n + c] || 0;
      }
    }
    this.written += frames;
    this.pruneMarks();
  }

  private pruneMarks(): void {
    const oldest = this.oldestFrame();
    // Keep the last mark that starts at/before `oldest` so interpolation still covers the head.
    let drop = 0;
    while (drop + 1 < this.marks.length && this.marks[drop + 1].cumFrame <= oldest) drop++;
    if (drop > 0) this.marks.splice(0, drop);
  }

  /** Wall-clock time of the oldest retained frame, or null when empty. */
  startMs(): number | null {
    if (this.written === 0 || this.marks.length === 0) return null;
    return this.frameToMs(this.oldestFrame());
  }

  /** Wall-clock time just after the newest frame, or null when empty. */
  endMs(): number | null {
    if (this.written === 0 || this.marks.length === 0) return null;
    return this.frameToMs(this.written);
  }

  /** Map an absolute frame index to wall-clock using the chunk marks. */
  frameToMs(frame: number): number {
    const marks = this.marks;
    if (marks.length === 0) return 0;
    let m = marks[0];
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i].cumFrame <= frame) {
        m = marks[i];
        break;
      }
    }
    return m.wallTimeMs + ((frame - m.cumFrame) / this.sampleRate) * 1000;
  }

  /** Map a wall-clock time to an absolute frame index (clamped to the retained range). */
  msToFrame(ms: number): number {
    const marks = this.marks;
    const lo = this.oldestFrame();
    const hi = this.written;
    if (marks.length === 0) return lo;
    // Find the last mark whose wallTime <= ms.
    let idx = -1;
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i].wallTimeMs <= ms) {
        idx = i;
        break;
      }
    }
    let frame: number;
    if (idx < 0) {
      frame = marks[0].cumFrame - ((marks[0].wallTimeMs - ms) / 1000) * this.sampleRate;
    } else {
      const m = marks[idx];
      const next = marks[idx + 1];
      if (next) {
        // Interpolate within the chunk by actual wall-clock spacing so drift does not accumulate.
        const span = next.wallTimeMs - m.wallTimeMs;
        const t = span > 0 ? (ms - m.wallTimeMs) / span : 0;
        frame = m.cumFrame + Math.min(1, Math.max(0, t)) * (next.cumFrame - m.cumFrame);
      } else {
        frame = m.cumFrame + ((ms - m.wallTimeMs) / 1000) * this.sampleRate;
      }
    }
    return Math.round(Math.min(hi, Math.max(lo, frame)));
  }

  /** Copy out planar PCM for a wall-clock range (clamped). Returns null when empty. */
  slice(fromMs: number, toMs: number): PcmSlice | null {
    if (this.available() === 0) return null;
    const a = this.msToFrame(Math.min(fromMs, toMs));
    const b = this.msToFrame(Math.max(fromMs, toMs));
    return this.sliceFrames(a, b);
  }

  /** Copy out planar PCM for an absolute frame range (already clamped). */
  sliceFrames(fromFrame: number, toFrame: number): PcmSlice | null {
    const lo = this.oldestFrame();
    const a = Math.max(lo, Math.min(fromFrame, toFrame));
    const b = Math.min(this.written, Math.max(fromFrame, toFrame));
    const n = b - a;
    if (n <= 0) return null;
    const cap = this.capacity;
    const out: Float32Array[] = [];
    for (let c = 0; c < this.channelCount; c++) {
      const dst = new Float32Array(n);
      const src = this.channels[c];
      const s = a % cap;
      const first = Math.min(n, cap - s);
      dst.set(src.subarray(s, s + first), 0);
      if (first < n) dst.set(src.subarray(0, n - first), first);
      out.push(dst);
    }
    return { channels: out, sampleRate: this.sampleRate, startMs: this.frameToMs(a), durationMs: (n / this.sampleRate) * 1000 };
  }

  /** Copy out everything retained. */
  sliceAll(): PcmSlice | null {
    return this.sliceFrames(this.oldestFrame(), this.written);
  }

  /**
   * Resize the ring, keeping the newest audio. Also used when the tap's
   * sample rate / channel count changes (data is dropped in that case).
   */
  reconfigure(seconds: number, sampleRate = this.sampleRate, channelCount = this.channelCount): void {
    const sr = Math.max(1, Math.round(sampleRate));
    const cc = Math.max(1, channelCount);
    const cap = Math.max(1, Math.round(seconds * sr));
    if (sr !== this.sampleRate || cc !== this.channelCount) {
      this.sampleRate = sr;
      this.channelCount = cc;
      this.capacity = cap;
      this.written = 0;
      this.floor = 0;
      this.marks = [];
      this.allocate();
      return;
    }
    if (cap === this.capacity) return;
    const keep = Math.min(this.available(), cap);
    const from = this.written - keep;
    const kept = keep > 0 ? this.sliceFrames(from, this.written) : null;
    this.capacity = cap;
    this.floor = from;
    this.allocate();
    if (kept) {
      for (let c = 0; c < cc; c++) {
        const dst = this.channels[c];
        const src = kept.channels[c];
        for (let i = 0; i < keep; i++) dst[(from + i) % cap] = src[i];
      }
    }
    this.pruneMarks();
  }

  clear(): void {
    this.written = 0;
    this.floor = 0;
    this.marks = [];
    for (const ch of this.channels) ch.fill(0);
  }
}

/**
 * Peak envelope for a waveform display: `bins` values in 0..1 (max |sample|
 * over all channels within each bin). Pure helper, works on any PcmSlice.
 */
export function peaks(slice: PcmSlice, bins: number): Float32Array {
  const out = new Float32Array(Math.max(1, bins | 0));
  const n = slice.channels[0]?.length ?? 0;
  if (n === 0) return out;
  const per = n / out.length;
  for (let b = 0; b < out.length; b++) {
    const s = Math.floor(b * per);
    const e = Math.max(s + 1, Math.floor((b + 1) * per));
    let peak = 0;
    for (const ch of slice.channels) {
      for (let i = s; i < e && i < n; i++) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
    }
    out[b] = Math.min(1, peak);
  }
  return out;
}

/** Sub-slice of an in-memory PcmSlice by wall-clock (relative to `slice.startMs`). */
export function subSlice(slice: PcmSlice, fromMs: number, toMs: number): PcmSlice {
  const n = slice.channels[0]?.length ?? 0;
  const toIdx = (ms: number) => Math.round(((ms - slice.startMs) / 1000) * slice.sampleRate);
  const a = Math.max(0, Math.min(n, toIdx(Math.min(fromMs, toMs))));
  const b = Math.max(a, Math.min(n, toIdx(Math.max(fromMs, toMs))));
  return {
    channels: slice.channels.map((ch) => ch.slice(a, b)),
    sampleRate: slice.sampleRate,
    startMs: slice.startMs + (a / slice.sampleRate) * 1000,
    durationMs: ((b - a) / slice.sampleRate) * 1000,
  };
}
