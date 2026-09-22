import { describe, expect, it } from 'vitest';
import { createAgentRuntime, createNativePointer, hexdump, parseUserScriptHeader, type AgentRuntimeHost, type AgentTextEvent, type GuestMemoryView } from './agent-runtime-api';

/** Fake PSP memory: a sparse map of guest pages backed by one Uint8Array window. */
function fakeMemory(base = 0x08800000, size = 0x10000): GuestMemoryView & { bytes: Uint8Array; write(addr: number, data: Uint8Array | string): void } {
  const bytes = new Uint8Array(size);
  return {
    bytes,
    read(addr, length) {
      if (addr < base || addr + length > base + size) return null;
      return bytes.slice(addr - base, addr - base + length);
    },
    write(addr, data) {
      const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      bytes.set(b, addr - base);
    },
  };
}

function sjis(s: string): Uint8Array {
  // Minimal Shift-JIS bytes for the test strings (pre-encoded).
  const table: Record<string, number[]> = {
    'こんにちは': [0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd],
    '世界': [0x90, 0xa2, 0x8a, 0x45],
  };
  if (!(s in table)) throw new Error('no sjis for ' + s);
  return new Uint8Array([...table[s], 0]);
}

/** Deterministic timers driven by a fake clock. */
function fakeHost(memory: GuestMemoryView) {
  let now = 0;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  let id = 1;
  const emitted: AgentTextEvent[] = [];
  const logs: string[] = [];
  const host: AgentRuntimeHost = {
    memory,
    emit: (e) => emitted.push(e),
    log: (level, m) => logs.push(`${level}: ${m}`),
    now: () => now,
    setTimeout: (fn, ms) => { timeouts.set(id, { at: now + ms, fn }); return id++; },
    clearTimeout: (t) => void timeouts.delete(t),
    setInterval: (fn, ms) => { intervals.set(id, { every: ms, next: now + ms, fn }); return id++; },
    clearInterval: (t) => void intervals.delete(t),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let next = end, which: (() => void) | null = null;
      for (const [k, t] of timeouts) if (t.at <= next) { next = t.at; which = () => { timeouts.delete(k); t.fn(); }; }
      for (const [, i] of intervals) if (i.next <= next) { next = i.next; which = () => { i.next += i.every; i.fn(); }; }
      if (!which || next > end) break;
      now = next;
      which();
    }
    now = end;
  };
  return { host, advance, emitted, logs };
}

describe('Agent runtime — NativePointer over guest memory', () => {
  it('reads integers, pointers and Shift-JIS strings at guest addresses', () => {
    const mem = fakeMemory();
    mem.write(0x08800010, new Uint8Array([0x78, 0x56, 0x34, 0x12]));
    mem.write(0x08800020, new Uint8Array([0x00, 0x01, 0x80, 0x08])); // pointer → 0x08800100
    mem.write(0x08800100, sjis('こんにちは'));
    const p = createNativePointer(mem, 0x08800010);
    expect(p.readU32()).toBe(0x12345678);
    expect(p.add(0x10).readPointer().vm).toBe(0x08800100);
    expect(p.add(0x10).readPointer().readShiftJisString()).toBe('こんにちは');
    expect(p.toString()).toBe('0x8800010');
    expect(() => createNativePointer(mem, 0x01000000).readU8()).toThrow(/access violation/);
    expect(hexdump(createNativePointer(mem, 0x08800010), { length: 4, header: false })).toContain('78 56 34 12');
  });
});

describe('Agent runtime — scripts', () => {
  const SCRIPT = `
// ==UserScript==
// @name         [TEST] Fake game
// @version      0.1
// ==/UserScript==
const { setWatch, setHook } = require('./libPPSSPP.js');
const mainHandler = trans.send(handler, '200++');
setWatch({ 0x08800100: mainHandler }, { size: 32, intervalMs: 50 });
setHook({ 0x08804400: function () { return null; } });
function handler(regs) {
  const s = regs[0].value.readShiftJisString();
  if (!s || s === 'init') return null;
  return s;
}
trans.replace(function (s) { return s.trim() + '!'; });
console.log('loaded ' + this === undefined);
`;

  it('parses the userscript header', () => {
    expect(parseUserScriptHeader(SCRIPT)['name']).toBe('[TEST] Fake game');
    expect(parseUserScriptHeader('nothing')).toEqual({});
  });

  it('runs an Agent-format script: setWatch fires when the buffer changes (after settling), joins fragments and applies replace', () => {
    const mem = fakeMemory();
    mem.write(0x08800100, 'init\0');
    const { host, advance, emitted, logs } = fakeHost(mem);
    const rt = createAgentRuntime(host);
    rt.load(SCRIPT, 'test');
    const regs = rt.registrations();
    expect(regs).toEqual([{ address: 0x08800100, kind: 'watch', active: true }, { address: 0x08804400, kind: 'hook', active: false }]);
    expect(logs.some((l) => /setHook.*inactive/.test(l))).toBe(true);
    advance(200); // initial content recorded, no emission ('init' placeholder & fireInitial=false)
    expect(emitted).toEqual([]);
    mem.write(0x08800100, sjis('こんにちは'));
    advance(60); // 1st poll sees the change, waits for a second identical poll (settlePolls=2)
    expect(emitted).toEqual([]);
    advance(60); // stable → handler → buffered by trans.send('200++')
    expect(emitted).toEqual([]);
    advance(250); // join window elapsed → replace() → emit
    expect(emitted.length).toBe(1);
    expect(emitted[0].text).toBe('こんにちは!');
    expect(emitted[0].source).toBe('0x8800100');
    // unchanged memory: nothing more
    advance(1000);
    expect(emitted.length).toBe(1);
    // a second line
    mem.write(0x08800100, sjis('世界'));
    advance(400);
    expect(emitted.map((e) => e.text)).toEqual(['こんにちは!', '世界!']);
    rt.dispose();
    mem.write(0x08800100, sjis('こんにちは'));
    advance(1000);
    expect(emitted.length).toBe(2); // disposed: watch stopped
  });

  it("'++' appends fragments within the window; without '+' the last fragment wins", () => {
    const mem = fakeMemory();
    const { host, advance, emitted } = fakeHost(mem);
    const rt = createAgentRuntime(host);
    const trans = rt.globals['trans'] as { send(h: (r: unknown[]) => unknown, spec?: string): (this: unknown, r: unknown[]) => unknown };
    const ctx = { context: { pc: 1, address: 1 } };
    const joined = trans.send((r) => r[0] as string, '100++');
    joined.call(ctx, ['名前']);
    joined.call(ctx, ['台詞']);
    advance(150);
    const last = trans.send((r) => r[0] as string, '100');
    last.call(ctx, ['a']);
    last.call(ctx, ['b']);
    advance(150);
    expect(emitted.map((e) => e.text)).toEqual(['名前台詞', 'b']);
  });

  it('reports script load errors instead of throwing into the host', () => {
    const { host } = fakeHost(fakeMemory());
    const rt = createAgentRuntime(host);
    expect(() => rt.load('this is not javascript', 'bad')).toThrow();
  });
});
