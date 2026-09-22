/**
 * Agent-compatible script runtime for the web emulator.
 *
 * Agent (github.com/0xDC00/agent) text-hook scripts are plain JavaScript written against
 * a small Frida-flavoured surface: `require('./libPPSSPP.js').setHook({ pc: handler })`,
 * handlers that receive MIPS argument registers as `NativePointer`s (`regs[0].value`,
 * `.readShiftJisString()`, `.add()`, `.readU32()` …), `trans.send(handler, '400++')` to
 * join fragments over a time window and `trans.replace(fn)` to post-process the line.
 *
 * This module implements that surface over a *guest memory view* (the PSP address space
 * exposed by the reading bridge, see ppsspp-runtime.js `guestMemory`). It is pure — no
 * DOM, no Worker — so it can be unit-tested with a Uint8Array standing in for the
 * emulator's memory; `agent-sandbox.worker.ts` wires it to the real shared memory.
 *
 * What differs from desktop Agent (and why):
 *  - `setHook(pc → handler)` needs breakpoints in the JIT; the prebuilt WASM emulator has
 *    no debugger export, so `setHook` registers the hooks, reports them as *inactive* and
 *    calls nothing. Scripts get `setWatch(address → handler, opts)` instead: the runtime
 *    polls the guest memory at `address` and invokes the handler when the bytes change,
 *    with `regs[0].value` pointing at the watched address (so a hook handler that reads
 *    its first argument works unchanged). This is the "read code" model of Textractor /
 *    Cheat-Engine-style hooks and covers text buffers, which is what dialogue hooks read.
 *  - `readShiftJisString` uses TextDecoder('shift_jis'); `readBinaryString` = Shift-JIS
 *    until NUL (Agent's helper of the same name).
 */

export interface GuestMemoryView {
  /** Copy of `length` bytes at guest address `addr`, or null when unmapped/unknown. */
  read(addr: number, length: number): Uint8Array | null;
}

export interface AgentTextEvent {
  text: string;
  /** Wall clock (performance.now() domain of the caller) when the *first* fragment arrived. */
  at: number;
  /** Which watch/hook produced it (hex address). */
  source: string;
}

export interface AgentRuntimeHost {
  memory: GuestMemoryView;
  emit(ev: AgentTextEvent): void;
  log(level: 'log' | 'info' | 'warn' | 'error', message: string): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
}

export interface WatchOptions {
  /** Bytes compared per poll (default 256). */
  size?: number;
  /** Poll interval in ms (default 50). */
  intervalMs?: number;
  /** Fire only after the bytes have been unchanged for this many polls (default 2). */
  settlePolls?: number;
  /** Fire the handler once for the initial content too (default false). */
  fireInitial?: boolean;
}

export interface HookRegistration { address: number; kind: 'hook' | 'watch'; active: boolean }

type Handler = (this: HandlerContext, regs: NativePointerLike[]) => unknown;
interface HandlerContext { context: { pc: number; address: number }; returnAddress: number }

const SJIS = typeof TextDecoder !== 'undefined' ? safeDecoder('shift_jis') : null;
const UTF8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
const UTF16 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-16le') : null;
function safeDecoder(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

/** Frida-like NativePointer over guest memory (32-bit PSP addresses). */
export interface NativePointerLike {
  readonly vm: number;
  readonly value: NativePointerLike;
  add(n: number | NativePointerLike): NativePointerLike;
  sub(n: number | NativePointerLike): NativePointerLike;
  and(n: number): NativePointerLike;
  toUInt32(): number;
  toInt32(): number;
  toString(radix?: number): string;
  isNull(): boolean;
  equals(o: NativePointerLike | number): boolean;
  readU8(): number;
  readS8(): number;
  readU16(): number;
  readS16(): number;
  readU32(): number;
  readS32(): number;
  readFloat(): number;
  readPointer(): NativePointerLike;
  readByteArray(length: number): ArrayBuffer;
  readCString(length?: number): string;
  readUtf8String(length?: number): string;
  readUtf16String(length?: number): string;
  readAnsiString(length?: number): string;
  readShiftJisString(length?: number): string;
}

export function createNativePointer(memory: GuestMemoryView, vm: number): NativePointerLike {
  const v = vm >>> 0;
  const rd = (len: number): Uint8Array => {
    const b = memory.read(v, len);
    if (!b) throw new Error(`access violation reading 0x${v.toString(16)}`);
    return b;
  };
  const cstr = (len?: number): Uint8Array => {
    if (len !== undefined && len >= 0) return rd(len);
    // read in growing chunks until NUL (max 4 KiB)
    for (let n = 64; n <= 4096; n *= 2) {
      const b = memory.read(v, n);
      if (!b) throw new Error(`access violation reading 0x${v.toString(16)}`);
      const z = b.indexOf(0);
      if (z >= 0) return b.subarray(0, z);
      if (n === 4096) return b;
    }
    return new Uint8Array(0);
  };
  const p: NativePointerLike = {
    vm: v,
    get value() {
      return p;
    },
    add: (n) => createNativePointer(memory, v + (typeof n === 'number' ? n : n.vm)),
    sub: (n) => createNativePointer(memory, v - (typeof n === 'number' ? n : n.vm)),
    and: (n) => createNativePointer(memory, v & n),
    toUInt32: () => v,
    toInt32: () => v | 0,
    toString: (radix = 16) => (radix === 16 ? '0x' + v.toString(16) : v.toString(radix)),
    isNull: () => v === 0,
    equals: (o) => (typeof o === 'number' ? o >>> 0 : o.vm) === v,
    readU8: () => rd(1)[0],
    readS8: () => (rd(1)[0] << 24) >> 24,
    readU16: () => { const b = rd(2); return b[0] | (b[1] << 8); },
    readS16: () => { const b = rd(2); return ((b[0] | (b[1] << 8)) << 16) >> 16; },
    readU32: () => { const b = rd(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; },
    readS32: () => { const b = rd(4); return b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24); },
    readFloat: () => { const b = rd(4); return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true); },
    readPointer: () => createNativePointer(memory, p.readU32()),
    readByteArray: (length) => { const b = rd(length); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; },
    readCString: (len) => latin1(cstr(len)),
    readAnsiString: (len) => latin1(cstr(len)),
    readUtf8String: (len) => (UTF8 ? UTF8.decode(cstr(len)) : latin1(cstr(len))),
    readUtf16String: (len) => {
      if (len !== undefined && len >= 0) return UTF16 ? UTF16.decode(rd(len * 2)) : '';
      for (let n = 128; n <= 8192; n *= 2) {
        const b = memory.read(v, n);
        if (!b) throw new Error(`access violation reading 0x${v.toString(16)}`);
        for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return UTF16 ? UTF16.decode(b.subarray(0, i)) : '';
        if (n === 8192) return UTF16 ? UTF16.decode(b) : '';
      }
      return '';
    },
    readShiftJisString: (len) => decodeShiftJis(cstr(len)),
  };
  return p;
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function decodeShiftJis(b: Uint8Array): string {
  if (SJIS) return SJIS.decode(b);
  return latin1(b);
}

export function hexdump(target: NativePointerLike | ArrayBuffer | Uint8Array, opts: { length?: number; header?: boolean } = {}): string {
  const length = opts.length ?? 256;
  let bytes: Uint8Array;
  let baseAddr = 0;
  if (target instanceof Uint8Array) bytes = target.subarray(0, length);
  else if (target instanceof ArrayBuffer) bytes = new Uint8Array(target, 0, Math.min(length, target.byteLength));
  else {
    bytes = new Uint8Array(target.readByteArray(length));
    baseAddr = target.vm;
  }
  const lines: string[] = [];
  if (opts.header !== false) lines.push('           0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F  0123456789ABCDEF');
  for (let o = 0; o < bytes.length; o += 16) {
    const row = bytes.subarray(o, o + 16);
    const hex = Array.from(row, (x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const asc = Array.from(row, (x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('');
    lines.push(`${(baseAddr + o).toString(16).padStart(8, '0')}  ${hex}  ${asc}`);
  }
  return lines.join('\n');
}

/**
 * `trans`: Agent's text sink. `send(handler, spec)` wraps a handler so its string results
 * are joined over a window (`'400'` = 400 ms; a trailing `+`/`++` appends fragments instead
 * of keeping only the last) and then passed through `replace` before emission.
 */
export interface Trans {
  send(handler: Handler, spec?: string | number): Handler;
  replace(fn: (s: string) => string | null | undefined): void;
  /** Emit a line directly (web extension; e.g. from a watch that already has the whole line). */
  emit(text: string): void;
  onBeforeTranslate?: (s: string) => string | null | undefined;
}

export interface AgentRuntime {
  globals: Record<string, unknown>;
  registrations(): HookRegistration[];
  /** Run one script (Agent userscript text). Throws on syntax/runtime errors at load. */
  load(source: string, name?: string): void;
  dispose(): void;
}

export function createAgentRuntime(host: AgentRuntimeHost): AgentRuntime {
  const regs: HookRegistration[] = [];
  let replaceFn: ((s: string) => string | null | undefined) | null = null;
  const timers = new Set<number>();
  const intervals = new Set<number>();
  let disposed = false;

  const emitFinal = (text: string, at: number, source: string) => {
    let s: string | null | undefined = text;
    if (trans.onBeforeTranslate) s = trans.onBeforeTranslate(s);
    if (s != null && replaceFn) s = replaceFn(s);
    if (s == null) return;
    s = String(s);
    if (!s.trim()) return;
    host.emit({ text: s, at, source });
  };

  const trans: Trans = {
    send(handler, spec = '0') {
      const str = String(spec ?? '0');
      const windowMs = Number.parseInt(str, 10) || 0;
      const append = /\+/.test(str);
      let buffer = '';
      let firstAt = 0;
      let timer: number | null = null;
      let source = '';
      const flush = () => {
        timer = null;
        const text = buffer;
        buffer = '';
        if (text) emitFinal(text, firstAt, source);
      };
      const wrapped: Handler = function (this: HandlerContext, r: NativePointerLike[]) {
        const out = handler.call(this, r);
        if (out == null) return out;
        const piece = String(out);
        if (!piece) return out;
        if (!buffer) firstAt = host.now();
        source = '0x' + (this?.context?.address ?? this?.context?.pc ?? 0).toString(16);
        buffer = append ? buffer + piece : piece;
        if (windowMs <= 0) {
          flush();
          return out;
        }
        if (timer !== null) host.clearTimeout(timer);
        timer = host.setTimeout(flush, windowMs);
        timers.add(timer);
        return out;
      };
      return wrapped;
    },
    replace(fn) {
      replaceFn = fn;
    },
    emit(text) {
      emitFinal(text, host.now(), 'script');
    },
  };

  const ptr = (x: number | string | NativePointerLike): NativePointerLike => {
    if (typeof x === 'object') return x;
    const n = typeof x === 'string' ? Number.parseInt(x, x.startsWith('0x') ? 16 : 10) : x;
    return createNativePointer(host.memory, n >>> 0);
  };

  const setHook = (map: Record<string, Handler>) => {
    for (const key of Object.keys(map)) {
      const address = Number(key) >>> 0;
      regs.push({ address, kind: 'hook', active: false });
    }
    host.log('warn', `setHook: ${Object.keys(map).length} PC hook(s) registered but inactive — the web emulator has no JIT breakpoints; use setWatch(address → handler) on the text buffer instead`);
    return false;
  };

  const setWatch = (map: Record<string, Handler>, opts: WatchOptions = {}) => {
    const size = Math.max(1, Math.min(65536, opts.size ?? 256));
    const intervalMs = Math.max(10, opts.intervalMs ?? 50);
    const settle = Math.max(1, opts.settlePolls ?? 2);
    for (const key of Object.keys(map)) {
      const address = Number(key) >>> 0;
      const handler = map[key];
      const reg: HookRegistration = { address, kind: 'watch', active: true };
      regs.push(reg);
      let last: Uint8Array | null = null;
      let pendingSince = -1;
      let stable = 0;
      let candidate: Uint8Array | null = null;
      const fire = () => {
        const thiz: HandlerContext = { context: { pc: address, address }, returnAddress: 0 };
        const p = createNativePointer(host.memory, address);
        try {
          handler.call(thiz, [p, p.add(4), p.add(8), p.add(12)]);
        } catch (e) {
          host.log('error', `watch 0x${address.toString(16)}: ${(e as Error)?.message ?? e}`);
        }
      };
      const tick = () => {
        if (disposed) return;
        const cur = host.memory.read(address, size);
        if (!cur) return; // base unknown yet
        if (last === null) {
          last = cur;
          if (opts.fireInitial) fire();
          return;
        }
        if (!bytesEqual(cur, last)) {
          // changed: wait until it stops changing (the game may write the buffer incrementally)
          if (candidate && bytesEqual(cur, candidate)) stable++;
          else {
            candidate = cur;
            stable = 1;
            pendingSince = host.now();
          }
          if (stable >= settle) {
            last = cur;
            candidate = null;
            stable = 0;
            fire();
          }
        } else if (candidate) {
          // reverted to the old content before settling: nothing happened
          candidate = null;
          stable = 0;
        }
        void pendingSince;
      };
      const id = host.setInterval(tick, intervalMs);
      intervals.add(id);
    }
  };

  const lib = Object.freeze({ setHook, setWatch });
  const require = (name: string) => {
    if (/lib(PPSSPP|PSP|Web)(\.web)?\.js$/i.test(name) || /libPPSSPP/i.test(name)) return lib;
    if (/libHelperEncoding/i.test(name)) return { decodeShiftJis };
    host.log('warn', `require('${name}') is not available in the web runtime; returning an empty module`);
    return {};
  };
  const consoleShim = {
    log: (...a: unknown[]) => host.log('log', a.map(String).join(' ')),
    info: (...a: unknown[]) => host.log('info', a.map(String).join(' ')),
    warn: (...a: unknown[]) => host.log('warn', a.map(String).join(' ')),
    error: (...a: unknown[]) => host.log('error', a.map(String).join(' ')),
    debug: (...a: unknown[]) => host.log('log', a.map(String).join(' ')),
  };
  const sessionStore = new Map<string, unknown>();
  const sessionStorage = {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: unknown) => void sessionStore.set(k, v),
    removeItem: (k: string) => void sessionStore.delete(k),
    get length() { return sessionStore.size; },
    key: (i: number) => Array.from(sessionStore.keys())[i] ?? null,
  };
  const readBinaryString = (p: NativePointerLike | number, len?: number) => ptr(p).readShiftJisString(len);
  const globals: Record<string, unknown> = {
    require,
    trans,
    console: consoleShim,
    ptr,
    NativePointer: { prototype: {} },
    NULL: ptr(0),
    hexdump,
    readBinaryString,
    sessionStorage,
    setHook,
    setWatch,
    Process: { platform: 'web', arch: 'wasm32', pointerSize: 4, id: 0, getModuleByName: () => ({ base: ptr(0x08804000), size: 0 }), enumerateModules: () => [] },
    Memory: { readByteArray: (p: NativePointerLike | number, n: number) => ptr(p).readByteArray(n), scanSync: () => [] },
    Interceptor: { attach: () => { host.log('warn', 'Interceptor.attach is not available in the web runtime'); return { detach() {} }; } },
    module: { parent: {} , exports: {} },
  };

  return {
    globals,
    registrations: () => regs.slice(),
    load(source: string, name = 'script') {
      const names = Object.keys(globals);
      // The script runs as a function body with the Agent globals as parameters (no DOM access
      // beyond what the worker exposes; the worker has none).
      // Inside a block so a script may `const { setHook } = require(...)` or `var trans`-shadow
      // the provided names without a redeclaration error (they are parameters of this function).
      const fn = new Function(...names, `"use strict";\n{\n${source}\n}\n//# sourceURL=agent:${name}`) as (...args: unknown[]) => void;
      fn(...names.map((n) => globals[n]));
    },
    dispose() {
      disposed = true;
      for (const t of timers) host.clearTimeout(t);
      for (const i of intervals) host.clearInterval(i);
      timers.clear();
      intervals.clear();
    },
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Parse the `// ==UserScript== … // ==/UserScript==` header of an Agent script. */
export function parseUserScriptHeader(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/.exec(source);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const mm = /^\s*\/\/\s*@(\w+)\s+(.*?)\s*$/.exec(line);
    if (mm) out[mm[1]] = mm[2];
  }
  return out;
}
