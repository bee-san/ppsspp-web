/// <reference lib="webworker" />
/**
 * MP3 encoder worker: receives planar Float32 PCM, returns MP3 bytes.
 * Keeps lamejs off the emulator's main thread.
 */
import { encodeMp3 } from './mp3-pcm';

export interface Mp3WorkerRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  kbps: number;
}

export type Mp3WorkerResponse = { id: number; ok: true; mp3: Uint8Array<ArrayBuffer> } | { id: number; ok: false; error: string } | { id: number; progress: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<Mp3WorkerRequest>) => {
  const { id, channels, sampleRate, kbps } = ev.data;
  try {
    let lastPct = -1;
    const mp3 = encodeMp3(channels, {
      sampleRate,
      kbps,
      onProgress: (done, total) => {
        const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
        if (pct !== lastPct) {
          lastPct = pct;
          ctx.postMessage({ id, progress: pct } satisfies Mp3WorkerResponse);
        }
      },
    });
    ctx.postMessage({ id, ok: true, mp3 } satisfies Mp3WorkerResponse, [mp3.buffer]);
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: (e as Error)?.message ?? String(e) } satisfies Mp3WorkerResponse);
  }
};
