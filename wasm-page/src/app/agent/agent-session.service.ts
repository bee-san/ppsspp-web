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
import { DEFAULT_AGENT_SETTINGS, loadAgentSettings, saveAgentSettings, type AgentDiagnostics, type AgentSettings, type GameIdentity, type HookedLine } from './agent-types';
import { parseUserScriptHeader } from './agent-runtime-api';
import { readGameMeta } from './game-meta';
import { findText, suggestWatchSize, watchScriptFor, type TextHit } from './text-finder';
import { analyzeScript, BUNDLED_SCRIPTS, CATALOG_API, loadCatalogCache, loadLibrary, parseCatalog, saveCatalogCache, saveLibrary, scriptFromSource, scriptsForDisc, searchCatalog, type CatalogEntry, type LibraryScript } from './script-library';
import type { AgentWorkerRequest, AgentWorkerResponse } from './agent-sandbox.worker';
import type { BridgeState, LifecycleEvent } from '../ocr/ocr-types';

/** Reading bridge v3 surface used here (see public/ppsspp-runtime.js). */
export interface RawReadingBridgeV3 {
  version: number;
  getState(): BridgeState;
  subscribeLifecycle(cb: (ev: LifecycleEvent) => void): () => void;
  getGameFile?(): Blob | null;
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
  /** Script library: bundled + user + community. */
  readonly library = signal<readonly LibraryScript[]>(loadLibrary(localStorage));
  readonly selected = computed(() => this.library().find((s) => s.id === this.settings().selectedScriptId) ?? null);
  /** Running game identity (file name from the bridge; disc ID/title parsed from the image). */
  readonly game = signal<GameIdentity>({ fileName: null, discId: null, title: null });
  /** Library scripts matching the running game's disc ID. */
  readonly matching = computed(() => scriptsForDisc(this.library(), this.game().discId));
  readonly catalog = signal<CatalogEntry[] | null>(null);
  readonly catalogState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly catalogError = signal('');
  readonly importing = signal<string | null>(null);

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
    this.game.set({ ...this.game(), fileName: raw.getState().gameId });
    this.unsubscribe = raw.subscribeLifecycle((ev) => this.onLifecycle(ev));
    void this.loadBundled();
    const f = raw.getGameFile?.();
    if (f) void this.identifyGame(f);
    this.sync();
  }

  /** Bundled scripts are fetched from the app's own assets and merged into the library. */
  private async loadBundled(): Promise<void> {
    const added: LibraryScript[] = [];
    for (const b of BUNDLED_SCRIPTS) {
      try {
        const res = await fetch(b.path, { cache: 'no-store' });
        if (!res.ok) continue;
        const src = await res.text();
        const sc = scriptFromSource(src, 'bundled', { id: b.id, fileName: b.path });
        added.push({ ...sc, name: sc.name || b.name, discIds: Array.from(new Set([...sc.discIds, ...b.discIds])) });
      } catch {
        /* offline: skip */
      }
    }
    if (added.length) {
      this.library.set([...added, ...this.library().filter((s) => s.origin !== 'bundled')]);
      this.autoSelectForGame();
    }
  }

  /** Parse PARAM.SFO out of the game image for the disc ID and title. */
  private async identifyGame(file: Blob): Promise<void> {
    try {
      const meta = await readGameMeta(file as unknown as Parameters<typeof readGameMeta>[0]);
      this.game.set({ ...this.game(), discId: meta.discId, title: meta.title });
      this.pushLog('info', `game: ${meta.discId ?? '(no disc id)'} ${meta.title ?? ''} (${meta.source})`);
    } catch (e) {
      this.pushLog('warn', 'could not read PARAM.SFO: ' + String(e));
    }
    this.autoSelectForGame();
  }

  /** With auto-select on, pick the library script for the running disc when one exists. */
  private autoSelectForGame(): void {
    const s = this.settings();
    if (!s.autoSelect) return;
    const m = this.matching();
    if (!m.length) return;
    if (m.some((x) => x.id === s.selectedScriptId)) return;
    this.selectScript(m[0].id, { reason: 'auto' });
  }

  // ─────────────────────────── library ───────────────────────────

  selectScript(id: string, opts: { reason?: 'auto' | 'user' } = {}): void {
    const sc = this.library().find((x) => x.id === id) ?? null;
    this.update({ selectedScriptId: sc ? sc.id : '', script: sc ? sc.source : '', scriptName: sc ? sc.name : '' });
    if (sc && opts.reason === 'auto') this.pushLog('info', `auto-selected "${sc.name}" for ${this.game().discId}`);
  }

  /** Add (or replace by identical id) a script from source text; returns it. */
  addScript(source: string, origin: 'user' | 'community' = 'user', opts: { url?: string; fileName?: string; select?: boolean } = {}): LibraryScript {
    const sc = scriptFromSource(source, origin, { url: opts.url, fileName: opts.fileName });
    const rest = this.library().filter((x) => x.id !== sc.id && !(opts.url && x.url === opts.url));
    const lib = [...rest, sc];
    this.library.set(lib);
    saveLibrary(localStorage, lib);
    if (opts.select !== false) this.selectScript(sc.id, { reason: 'user' });
    return sc;
  }

  /** Replace the source of an existing user/community script (editing). */
  updateScriptSource(id: string, source: string): void {
    const cur = this.library().find((x) => x.id === id);
    if (!cur || cur.origin === 'bundled') {
      this.addScript(source, 'user');
      return;
    }
    const next = { ...scriptFromSource(source, cur.origin, { id: cur.id, url: cur.url }), addedAt: cur.addedAt };
    const lib = this.library().map((x) => (x.id === id ? next : x));
    this.library.set(lib);
    saveLibrary(localStorage, lib);
    if (this.settings().selectedScriptId === id) this.update({ script: next.source, scriptName: next.name });
  }

  removeScript(id: string): void {
    const cur = this.library().find((x) => x.id === id);
    if (!cur || cur.origin === 'bundled') return;
    const lib = this.library().filter((x) => x.id !== id);
    this.library.set(lib);
    saveLibrary(localStorage, lib);
    if (this.settings().selectedScriptId === id) this.update({ selectedScriptId: '', script: '', scriptName: '' });
  }

  analyze(source: string) {
    return analyzeScript(source);
  }

  /**
   * Search the emulated user RAM (0x08800000–0x0a000000, 24 MiB, read in 1 MiB windows) for
   * `text` in Shift-JIS / UTF-8 / UTF-16LE. Yields to the event loop between windows.
   */
  async findTextInMemory(text: string): Promise<TextHit[]> {
    return (await this.findTextsInMemory([text])).get(text) ?? [];
  }

  /** Same, for several strings in one pass over memory. */
  async findTextsInMemory(texts: readonly string[]): Promise<Map<string, TextHit[]>> {
    const out = new Map<string, TextHit[]>(texts.map((t) => [t, []]));
    const b = this.bridge;
    if (!b || b.guestMemory.base() < 0 || !texts.length) return out;
    const { user, end } = b.guestMemory.layout;
    const WIN = 1 << 20;
    for (let a = user; a < end; a += WIN) {
      const bytes = b.guestMemory.read(a, Math.min(WIN, end - a) + 512); // overlap so matches on a window edge are found
      if (!bytes) break;
      for (const t of texts) {
        const acc = out.get(t)!;
        if (acc.length >= 64) continue;
        acc.push(...findText(t, [{ start: a, bytes }], { max: 64 - acc.length }));
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    for (const [t, hits] of out) {
      const seen = new Set<string>();
      out.set(t, hits.filter((h) => { const k = h.encoding + h.address; if (seen.has(k)) return false; seen.add(k); return true; }));
    }
    return out;
  }

  // ─────────────────────────── automatic discovery ───────────────────────────
  //
  // No working script for this game? Every time the OCR layer publishes new text we search
  // the user RAM for its longest line. An address that holds the on-screen line for TWO
  // different lines in a row is the game's dialogue buffer → generate a setWatch script for
  // it (like the "Find text in memory" button, but hands-free).
  private discoverySeen = new Map<number, { texts: Set<string>; encoding: string; lastText: string }>();
  private discoveryBusy = false;
  private discoveryLastText = '';
  private discoveryDoneFor = '';
  readonly discovering = signal<'off' | 'watching' | 'found'>('off');

  /** Called by the OCR layer with the recognized lines of each published layout. */
  observeScreenText(lines: readonly string[]): void {
    const s = this.settings();
    if (!s.enabled || !s.autoDiscover || !this.bridge || !this.gameRunning) return;
    if (this.bridge.guestMemory.base() < 0) return;
    const gameKey = this.game().discId ?? this.game().fileName ?? '';
    if (this.discoveryDoneFor === gameKey) return;
    // A working script already produces lines for this game: nothing to discover.
    const last = this.lines().at(-1);
    if (last && last.source === 'script' && performance.now() - last.at < 60_000) return;
    // The longest few lines on screen (a dialogue box's first line is usually the buffer start;
    // its second line sits mid-buffer, so every line is tried and only string-start hits count).
    const candidates = Array.from(new Set(lines.map((l) => l.replace(/\s+/g, '')).filter((l) => Array.from(l).length >= 4))).sort((a, b) => b.length - a.length).slice(0, 4);
    const key = candidates.join('\n');
    if (!candidates.length || key === this.discoveryLastText || this.discoveryBusy) return;
    this.discoveryLastText = key;
    this.discovering.set('watching');
    this.discoveryBusy = true;
    const needles = candidates.map((c) => Array.from(c).slice(0, 12).join(''));
    void this.findTextsInMemory(needles)
      .then((byText) => {
        const hits: TextHit[] = [];
        needles.forEach((n, i) => {
          for (const h of byText.get(n) ?? []) {
            hits.push(h);
            if (!h.atStringStart) continue;
            const e = this.discoverySeen.get(h.address) ?? { texts: new Set<string>(), encoding: h.encoding, lastText: '' };
            e.texts.add(candidates[i]);
            e.lastText = candidates[i];
            this.discoverySeen.set(h.address, e);
          }
        });
        // Two distinct lines at the same address → that is the buffer.
        const found = Array.from(this.discoverySeen.entries()).filter(([, e]) => e.texts.size >= 2).sort((a, b) => b[1].texts.size - a[1].texts.size)[0];
        if (found) {
          const [address, e] = found;
          const hit = hits.find((h) => h.address === address) ?? { address, encoding: e.encoding as 'shift_jis', length: 0, preview: e.lastText, atStringStart: true };
          const sc = this.createWatchScript(hit, { autoDiscovered: true });
          this.discoveryDoneFor = gameKey;
          this.discovering.set('found');
          this.pushLog('info', `auto-discovered the dialogue buffer at 0x${address.toString(16)} (${e.encoding}) from ${e.texts.size} on-screen lines → "${sc.name}"`);
          this.discoverySeen.clear();
        }
      })
      .catch((err) => this.pushLog('warn', 'discovery failed: ' + String(err)))
      .finally(() => (this.discoveryBusy = false));
  }

  /** Build and add a user script watching the found address; selects it. */
  createWatchScript(hit: TextHit, opts: { autoDiscovered?: boolean } = {}): LibraryScript {
    const b = this.bridge!;
    const probe = b.guestMemory.read(hit.address, 1024) ?? new Uint8Array(0);
    const size = suggestWatchSize(probe, hit.encoding);
    const g = this.game();
    const src = watchScriptFor(hit.address, hit.encoding, size, { discId: g.discId, title: (g.title ?? g.fileName ?? 'Game') + (opts.autoDiscovered ? ' (auto-discovered)' : '') });
    const sc = this.addScript(src, 'user', { select: true });
    if (!this.settings().enabled) this.update({ enabled: true });
    return sc;
  }

  /** Load the community catalog (GitHub listing of 0xDC00/scripts, cached for a day). */
  async loadCatalog(force = false): Promise<void> {
    if (!force) {
      const cached = loadCatalogCache(localStorage);
      if (cached) {
        this.catalog.set(cached);
        this.catalogState.set('ready');
        return;
      }
    }
    this.catalogState.set('loading');
    this.catalogError.set('');
    try {
      const res = await fetch(CATALOG_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub API ${res.status}${res.status === 403 ? ' (rate limit — try again later)' : ''}`);
      const entries = parseCatalog(await res.json());
      saveCatalogCache(localStorage, entries);
      this.catalog.set(entries);
      this.catalogState.set('ready');
    } catch (e) {
      this.catalogError.set((e as Error).message ?? String(e));
      this.catalogState.set('error');
    }
  }

  searchCatalog(query: string): CatalogEntry[] {
    return searchCatalog(this.catalog() ?? [], query);
  }

  /** Import a community script by URL (raw.githubusercontent serves CORS). */
  async importFromUrl(url: string, fileName?: string): Promise<LibraryScript | null> {
    this.importing.set(url);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const src = await res.text();
      const sc = this.addScript(src, 'community', { url, fileName: fileName ?? url.split('/').pop() });
      const a = analyzeScript(src);
      if (a.usesSetHook && !a.usesSetWatch) this.pushLog('warn', `"${sc.name}" uses setHook (code breakpoints) only — the browser runtime cannot fire those; it needs a setWatch on the text buffer`);
      return sc;
    } catch (e) {
      this.pushLog('error', `import failed: ${(e as Error).message ?? e}`);
      return null;
    } finally {
      this.importing.set(null);
    }
  }

  /** Subscribe to new lines (returns unsubscribe). */
  onLine(fn: (line: HookedLine) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(patch: Partial<AgentSettings>): void {
    const next = { ...this.settings(), ...patch, schemaVersion: 1 as const };
    if (patch.script !== undefined && patch.scriptName === undefined) {
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


  // ─────────────────────────── lifecycle ───────────────────────────

  private onLifecycle(ev: LifecycleEvent): void {
    if (ev.type === 'phase') {
      this.gameRunning = ev.phase === 'running';
      if (!this.gameRunning) this.stopWorker();
      this.sync();
    } else if (ev.type === 'game-changed') {
      // The runtime announces the mounted path after the file (game-file) — keep the identity
      // parsed from that file; only a different file resets it.
      const f = this.bridge?.getGameFile?.() ?? null;
      const sameFile = !!f && !!ev.gameId && (f as File).name?.replace(/[^a-zA-Z0-9._-]/g, '_') === ev.gameId;
      this.game.set(sameFile ? { ...this.game(), fileName: ev.gameId } : { fileName: ev.gameId, discId: null, title: null });
      if (!sameFile && f) void this.identifyGame(f);
      // new game → new memory layout; re-locate and restart the script
      this.discoverySeen.clear();
      this.discoveryLastText = '';
      this.discovering.set('off');
      this.restartWorker();
    } else if (ev.type === 'game-file') {
      if (ev.file) void this.identifyGame(ev.file);
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
      this.patchDiag({ phase: 'waiting', message: this.matching().length ? 'Select a script for this game' : `No script for this game${this.game().discId ? ` (${this.game().discId})` : ''} — pick one from the library or import it` });
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
