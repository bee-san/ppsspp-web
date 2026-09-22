/// <reference lib="webworker" />
/**
 * Agent script sandbox worker.
 *
 * Receives the emulator's SharedArrayBuffer and the guest arena base from the main thread,
 * builds the Agent-compatible runtime (agent-runtime-api.ts) over it and runs the user's
 * script here — off the emulator's main thread and without DOM access. Watch polls read the
 * shared memory directly; text lines and logs are posted back.
 */
import { createAgentRuntime, type AgentRuntime, type GuestMemoryView } from './agent-runtime-api';

export type AgentWorkerRequest =
  | { type: 'init'; buffer: SharedArrayBuffer; base: number; end: number; script: string; name: string }
  | { type: 'base'; base: number }
  | { type: 'stop' };

export type AgentWorkerResponse =
  | { type: 'ready'; hooks: number; watches: number }
  | { type: 'text'; text: string; /** epoch ms (performance.timeOrigin + now) */ at: number; source: string }
  | { type: 'log'; level: 'log' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let runtime: AgentRuntime | null = null;
let heap: Uint8Array | null = null;
let base = -1;
let end = 0;

const memory: GuestMemoryView = {
  read(addr, length) {
    if (!heap || base < 0) return null;
    addr = addr >>> 0;
    if (addr + length > end) return null;
    const off = base + addr;
    if (off + length > heap.length) return null;
    return heap.slice(off, off + length);
  },
};

ctx.onmessage = (ev: MessageEvent<AgentWorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'stop') {
    runtime?.dispose();
    runtime = null;
    ctx.close();
    return;
  }
  if (msg.type === 'base') {
    base = msg.base;
    return;
  }
  if (msg.type === 'init') {
    heap = new Uint8Array(msg.buffer);
    base = msg.base;
    end = msg.end;
    runtime?.dispose();
    runtime = createAgentRuntime({
      memory,
      // `at` is converted to an absolute epoch time: the worker's performance.now() has its own origin.
      emit: (e) => ctx.postMessage({ type: 'text', text: e.text, at: performance.timeOrigin + e.at, source: e.source } satisfies AgentWorkerResponse),
      log: (level, message) => ctx.postMessage({ type: 'log', level, message } satisfies AgentWorkerResponse),
      now: () => performance.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
      clearInterval: (id) => clearInterval(id),
    });
    try {
      runtime.load(msg.script, msg.name);
      const regs = runtime.registrations();
      ctx.postMessage({ type: 'ready', hooks: regs.filter((r) => r.kind === 'hook').length, watches: regs.filter((r) => r.kind === 'watch').length } satisfies AgentWorkerResponse);
    } catch (e) {
      ctx.postMessage({ type: 'error', message: (e as Error)?.message ?? String(e) } satisfies AgentWorkerResponse);
    }
  }
};
