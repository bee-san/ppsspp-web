/**
 * AgentSessionService — runs a text hook for the running game and publishes its lines.
 *
 * Sources:
 *  - in-browser Agent-style script (agent-sandbox.worker.ts) reading the emulated PSP memory
 *    through the reading bridge v3 (`guestMemory`: shared WebAssembly.Memory + arena base);
 *  - optional external WebSocket text hooker (desktop Agent on ws://localhost:9001,
 *    Textractor …) — plain text or GSM-style JSON `{ sentence | text, time? }`.
 *
 * Consumers read `lines()` / `latest()`; the OCR layer uses them to correct recognized
 * text (ocr-session.service.ts), mining uses the latest line for the Sentence field and
 * clip timing (mining-session.service.ts). Optionally every line is mirrored to the
 * clipboard (the classic texthooker → clipboard → GSM / clipboard inserter path).
 */
import { computed, Injectable, signal } from '@angular/core';
import { DEFAULT_AGENT_SETTINGS, loadAgentSettings, saveAgentSettings, type AgentDiagnostics, type AgentSettings, type HookedLine } from './agent-types';
import { parseUserScriptHeader } from './agent-runtime-api';
import type { AgentWorkerRequest, AgentWorkerResponse } from './agent-sandbox.worker';
import type { BridgeState, LifecycleEvent } from '../ocr/ocr-types';

/** Reading bridge v3 surface used here (see public/ppsspp-runtime.js). */
export interface RawReadingBridgeV3 {
  version: number;
  getState(): BridgeState;
  subscribeLifecycle(cb: (ev: LifecycleEvent) => void): () => void;
  guestMemory: {
    available(): boolean;
    base(force?: boolean): number;
    buffer(): SharedArrayBuffer | null;
    read(addr: number, length: number): Uint8Array | null;
    readU32(addr: number): number | null;
    layout: { scratchpad: number; vram: number; kernel: number; user: number; end: number };
  };
}

export interface AgentLogEntry { t: number; level: string; message: string }

const MAX_LINES = 200;
const MAX_LOG = 200;

@Injectable({ providedIn: 'root' })
export class AgentSessionService {
  readonly settings = signal<AgentSettings>(loadAgentSettings(localStorage));
  readonly diagnostics = signal<AgentDiagnostics>({ phase: 'off', message: 'Text hook is off', base: -1, hooks: 0, watches: 0, lines: 0, websocket: 'off', lastError: '' });
  readonly lines = signal<readonly HookedLine[]>([]);
  readonly latest = computed(() => this.lines().at(-1) ?? null);
  readonly log = signal<readonly AgentLogEntry[]>([]);
  /** Bridge v3 present (guest memory reachable). */
  readonly supported = signal<boolean | null>(null);

  private bridge: RawReadingBridgeV3 | null = null;
  private worker: Worker | null = null;
  private workerGen = 0;
  private baseTimer: number | null = null;
  private ws: WebSocket | null = null;
  private wsRetry: number | null = null;
  private wsUrlActive = '';
  private gameRunning = false;
  private attached = false;
  private nextId = 1;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<(line: HookedLine) => void>();

  /** Overridable for tests. */
  workerFactory: () => Worker = () => new Worker(new URL('./agent-sandbox.worker', import.meta.url), { type: 'module', name: 'ppsspp-agent' });

  async attach(): Promise<void> {
    if (this.attached) return;
    this.attached = true;
    const start = performance.now();
    let raw: RawReadingBridgeV3 | undefined;
    for (;;) {
      raw = (window as unknown as { PpssppReadingBridge?: RawReadingBridgeV3 }).PpssppReadingBridge;
      if (raw && typeof raw.version === 'number') break;
      if (performance.now() - start > 15_000) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!raw || raw.version < 3 || !raw.guestMemory) {
      this.supported.set(false);
      this.patchDiag({ phase: 'no-memory', message: 'Reading bridge v3 (guest memory) not available' });
      return;
    }
    this.supported.set(true);
    this.bridge = raw;
    this.gameRunning = raw.getState().phase === 'running';
    this.unsubscribe = raw.subscribeLifecycle((ev) => this.onLifecycle(ev));
    this.sync();
  }

  /** Subscribe to new lines (returns unsubscribe). */
  onLine(fn: (line: HookedLine) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(patch: Partial<AgentSettings>): void {
    const next = { ...this.settings(), ...patch, schemaVersion: 1 as const };
    if (patch.script !== undefined) {
      const h = parseUserScriptHeader(patch.script);
      next.scriptName = h['name'] ?? (patch.script.trim() ? 'script' : '');
    }
    const prev = this.settings();
    this.settings.set(next);
    saveAgentSettings(localStorage, next);
    if (next.enabled !== prev.enabled || next.script !== prev.script) this.restartWorker();
    if (next.websocketUrl !== prev.websocketUrl || next.enabled !== prev.enabled) this.syncWebSocket();
    this.sync();
  }

  toggleEnabled(): void {
    this.update({ enabled: !this.settings().enabled });
  }

  clearLines(): void {
    this.lines.set([]);
    this.patchDiag({ lines: 0 });
  }

  /** Test hook for E2E / the UI "Send test line" button. */
  injectLine(text: string, source: HookedLine['source'] = 'script', detail = 'manual'): void {
    this.pushLine(text, performance.now(), source, detail);
  }

  /** Reset the example script for the bundled test game. */
  static readonly EXAMPLE_SCRIPT_URL = 'test-game/agent-script.js';

  // ─────────────────────────── lifecycle ───────────────────────────

  private onLifecycle(ev: LifecycleEvent): void {
    if (ev.type === 'phase') {
      this.gameRunning = ev.phase === 'running';
      if (!this.gameRunning) this.stopWorker();
      this.sync();
    } else if (ev.type === 'game-changed') {
      // new game → new memory layout; re-locate and restart the script
      this.restartWorker();
    }
  }

  private sync(): void {
    const s = this.settings();
    if (!this.bridge) return;
    if (!s.enabled) {
      this.stopWorker();
      this.patchDiag({ phase: 'off', message: 'Text hook is off' });
      return;
    }
    if (!this.gameRunning) {
      this.patchDiag({ phase: 'waiting', message: 'Waiting for the game to run' });
      return;
    }
    if (!s.script.trim()) {
      this.patchDiag({ phase: 'waiting', message: 'No script loaded — paste an Agent script or load the test-game example' });
      return;
    }
    if (!this.worker) this.startWorker();
  }

  private startWorker(): void {
    const b = this.bridge;
    const s = this.settings();
    if (!b || !s.enabled || !this.gameRunning || !s.script.trim()) return;
    if (!b.guestMemory.available()) {
      this.patchDiag({ phase: 'no-memory', message: 'Emulator memory not captured (runtime too old?)' });
      return;
    }
    const buffer = b.guestMemory.buffer();
    if (!buffer) return;
    const base = b.guestMemory.base(true);
    const gen = ++this.workerGen;
    let w: Worker;
    try {
      w = this.workerFactory();
    } catch (e) {
      this.patchDiag({ phase: 'error', message: 'Cannot start the script worker', lastError: String(e) });
      return;
    }
    this.worker = w;
    w.onmessage = (ev: MessageEvent<AgentWorkerResponse>) => {
      if (gen !== this.workerGen) return;
      const m = ev.data;
      if (m.type === 'text') this.pushLine(m.text, Math.min(performance.now(), m.at - performance.timeOrigin), 'script', m.source);
      else if (m.type === 'log') this.pushLog(m.level, m.message);
      else if (m.type === 'ready') this.patchDiag({ phase: base >= 0 ? 'running' : 'locating', hooks: m.hooks, watches: m.watches, message: base >= 0 ? `Script running (${m.watches} watch${m.watches === 1 ? '' : 'es'}${m.hooks ? `, ${m.hooks} PC hook${m.hooks === 1 ? '' : 's'} inactive` : ''})` : 'Script loaded — locating the PSP memory arena…' });
      else if (m.type === 'error') {
        this.pushLog('error', m.message);
        this.patchDiag({ phase: 'error', message: 'Script error: ' + m.message, lastError: m.message });
      }
    };
    w.onerror = (e) => {
      if (gen !== this.workerGen) return;
      this.pushLog('error', e.message);
      this.patchDiag({ phase: 'error', message: 'Script worker error: ' + e.message, lastError: e.message });
    };
    w.postMessage({ type: 'init', buffer, base, end: b.guestMemory.layout.end, script: s.script, name: s.scriptName || 'script' } satisfies AgentWorkerRequest);
    this.patchDiag({ base, message: base >= 0 ? 'Script starting' : 'Locating the PSP memory arena…', phase: base >= 0 ? 'running' : 'locating' });
    // The arena appears once the game has booted; keep looking until found.
    this.clearBaseTimer();
    if (base < 0) {
      this.baseTimer = window.setInterval(() => {
        if (gen !== this.workerGen || !this.bridge) return this.clearBaseTimer();
        const nb = this.bridge.guestMemory.base(true);
        if (nb >= 0) {
          this.clearBaseTimer();
          this.worker?.postMessage({ type: 'base', base: nb } satisfies AgentWorkerRequest);
          const d = this.diagnostics();
          this.patchDiag({ base: nb, phase: 'running', message: `Script running (${d.watches} watch${d.watches === 1 ? '' : 'es'}${d.hooks ? `, ${d.hooks} PC hook${d.hooks === 1 ? '' : 's'} inactive` : ''}; arena at 0x${nb.toString(16)})` });
        }
      }, 500);
    }
  }

  private stopWorker(): void {
    this.clearBaseTimer();
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'stop' } satisfies AgentWorkerRequest);
      } catch {
        /* ignore */
      }
      this.worker.terminate();
      this.worker = null;
    }
    this.workerGen++;
  }

  private restartWorker(): void {
    this.stopWorker();
    this.sync();
  }

  private clearBaseTimer(): void {
    if (this.baseTimer !== null) {
      clearInterval(this.baseTimer);
      this.baseTimer = null;
    }
  }

  // ─────────────────────────── websocket input ───────────────────────────

  private syncWebSocket(): void {
    const s = this.settings();
    const want = s.enabled && s.websocketUrl ? s.websocketUrl : '';
    if (want === this.wsUrlActive && (this.ws || !want)) return;
    this.closeWebSocket();
    this.wsUrlActive = want;
    if (!want) {
      this.patchDiag({ websocket: 'off' });
      return;
    }
    this.openWebSocket();
  }

  private openWebSocket(): void {
    const url = this.wsUrlActive;
    if (!url) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.patchDiag({ websocket: 'closed', lastError: String(e) });
      return;
    }
    this.ws = ws;
    this.patchDiag({ websocket: 'connecting' });
    ws.onopen = () => this.patchDiag({ websocket: 'open' });
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) return;
      let text = raw;
      let at = performance.now();
      try {
        const j = JSON.parse(raw) as { sentence?: string; text?: string; time?: string | number };
        if (j && typeof j === 'object') {
          text = String(j.sentence ?? j.text ?? raw);
          if (j.time !== undefined) {
            const ms = typeof j.time === 'number' ? j.time : Date.parse(j.time);
            if (Number.isFinite(ms)) at = performance.now() - Math.max(0, Date.now() - ms);
          }
        }
      } catch {
        /* plain text */
      }
      this.pushLine(text, at, 'websocket', url);
    };
    ws.onclose = () => {
      this.patchDiag({ websocket: 'closed' });
      if (this.ws === ws) {
        this.ws = null;
        if (this.wsUrlActive) this.wsRetry = window.setTimeout(() => this.openWebSocket(), 3000);
      }
    };
    ws.onerror = () => this.patchDiag({ websocket: 'closed' });
  }

  private closeWebSocket(): void {
    if (this.wsRetry !== null) {
      clearTimeout(this.wsRetry);
      this.wsRetry = null;
    }
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }

  // ─────────────────────────── feed ───────────────────────────

  private pushLine(text: string, at: number, source: HookedLine['source'], detail: string): void {
    const t = text.replace(/\r\n?/g, '\n').trim();
    if (!t) return;
    const prev = this.lines();
    if (prev.length && prev[prev.length - 1].text === t && at - prev[prev.length - 1].at < 300) return; // duplicate burst
    const line: HookedLine = { id: this.nextId++, text: t, at, wall: Date.now(), source, detail };
    const next = prev.length >= MAX_LINES ? [...prev.slice(prev.length - MAX_LINES + 1), line] : [...prev, line];
    this.lines.set(next);
    this.patchDiag({ lines: next.length });
    if (this.settings().copyToClipboard) void this.copy(t);
    for (const fn of this.listeners) {
      try {
        fn(line);
      } catch (e) {
        console.warn('[agent] line listener failed', e);
      }
    }
  }

  private async copy(text: string): Promise<void> {
    try {
      if (document.hasFocus() && navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard not permitted; silent */
    }
  }

  private pushLog(level: string, message: string): void {
    const l = this.log();
    const e = { t: Date.now(), level, message };
    this.log.set(l.length >= MAX_LOG ? [...l.slice(l.length - MAX_LOG + 1), e] : [...l, e]);
  }

  private patchDiag(p: Partial<AgentDiagnostics>): void {
    this.diagnostics.set({ ...this.diagnostics(), ...p });
  }

  dispose(): void {
    this.stopWorker();
    this.closeWebSocket();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.attached = false;
  }

  static defaults(): AgentSettings {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}
