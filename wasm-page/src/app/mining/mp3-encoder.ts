/**
 * Mp3Encoder — main-thread client for mp3-encoder.worker.ts. One lazily created
 * worker; requests are serialised by id. Falls back to in-thread encoding when
 * workers are unavailable.
 */
import { encodeMp3 } from './mp3-pcm';
import type { Mp3WorkerRequest, Mp3WorkerResponse } from './mp3-encoder.worker';
import type { PcmSlice } from './mining-types';

interface Pending {
  resolve: (mp3: Uint8Array<ArrayBuffer>) => void;
  reject: (e: Error) => void;
  onProgress?: (pct: number) => void;
}

export class Mp3EncoderClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(private readonly workerFactory: () => Worker = () => new Worker(new URL('./mp3-encoder.worker', import.meta.url), { type: 'module', name: 'ppsspp-mp3' })) {}

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;
    try {
      const w = this.workerFactory();
      w.onmessage = (ev: MessageEvent<Mp3WorkerResponse>) => this.onMessage(ev.data);
      w.onerror = (ev) => {
        const err = new Error(`MP3 worker error: ${ev.message || 'unknown'}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.worker = null;
      };
      this.worker = w;
      return w;
    } catch (e) {
      console.warn('[mining] MP3 worker unavailable, encoding inline', e);
      return null;
    }
  }

  private onMessage(msg: Mp3WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if ('progress' in msg) {
      p.onProgress?.(msg.progress);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.mp3);
    else p.reject(new Error(msg.error));
  }

  /** Encode a PCM slice; the slice's channel buffers are copied (not transferred). */
  encode(slice: PcmSlice, kbps: number, onProgress?: (pct: number) => void): Promise<Blob> {
    const channels = slice.channels.map((c) => c.slice());
    const w = this.ensureWorker();
    if (!w) {
      const bytes = encodeMp3(channels, { sampleRate: slice.sampleRate, kbps });
      return Promise.resolve(new Blob([bytes], { type: 'audio/mpeg' }));
    }
    const id = this.nextId++;
    return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      const req: Mp3WorkerRequest = { id, channels, sampleRate: slice.sampleRate, kbps };
      w.postMessage(
        req,
        channels.map((c) => c.buffer),
      );
    }).then((bytes) => new Blob([bytes], { type: 'audio/mpeg' }));
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('encoder disposed'));
    this.pending.clear();
  }
}
