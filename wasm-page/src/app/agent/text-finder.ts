/**
 * Find where the game keeps the text on screen: encode a known string (typed by the user or
 * taken from the OCR layer / hooked feed) in the encodings PSP games use and search the
 * emulated user RAM for it. Each hit is a candidate address for `setWatch`. Pure functions
 * over a Uint8Array window so they are unit-testable; the worker/service supplies memory.
 *
 * Encodings: Shift-JIS (the vast majority of Japanese PSP games), UTF-8, UTF-16LE. Shift-JIS
 * encoding has no TextEncoder in browsers, so a small encoder is derived from the decoder
 * once (all 2-byte lead/trail combinations → char), cached.
 */

export type TextEncoding = 'shift_jis' | 'utf-8' | 'utf-16le';

export interface TextHit {
  address: number;
  encoding: TextEncoding;
  /** Bytes of the match. */
  length: number;
  /** A few bytes of context decoded around the hit (for display). */
  preview: string;
  /** True when the match is at the start of a NUL-terminated string (previous byte is 0). */
  atStringStart: boolean;
}

let sjisTable: Map<string, number[]> | null = null;

/** Build (once) a char → Shift-JIS bytes map from the platform decoder. */
export function shiftJisEncoder(): Map<string, number[]> {
  if (sjisTable) return sjisTable;
  const table = new Map<string, number[]>();
  let dec: TextDecoder | null = null;
  try {
    dec = new TextDecoder('shift_jis', { fatal: true });
  } catch {
    dec = null;
  }
  if (!dec) {
    sjisTable = table;
    return table;
  }
  // single bytes: ASCII + half-width katakana (0xA1–0xDF)
  for (let b = 0x20; b < 0x7f; b++) table.set(String.fromCharCode(b), [b]);
  for (let b = 0xa1; b <= 0xdf; b++) {
    try {
      table.set(dec.decode(new Uint8Array([b])), [b]);
    } catch {
      /* unmapped */
    }
  }
  // double bytes
  const buf = new Uint8Array(2);
  for (const [lo, hi] of [[0x81, 0x9f], [0xe0, 0xfc]] as const) {
    for (let lead = lo; lead <= hi; lead++) {
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue;
        buf[0] = lead;
        buf[1] = trail;
        try {
          const ch = dec.decode(buf);
          if (ch.length === 1 && !table.has(ch)) table.set(ch, [lead, trail]);
        } catch {
          /* unmapped */
        }
      }
    }
  }
  sjisTable = table;
  return table;
}

/** Encode `text`; returns null when a character has no representation in that encoding. */
export function encodeText(text: string, enc: TextEncoding): Uint8Array | null {
  if (enc === 'utf-8') return new TextEncoder().encode(text);
  if (enc === 'utf-16le') {
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[i * 2] = c & 0xff;
      out[i * 2 + 1] = c >> 8;
    }
    return out;
  }
  const table = shiftJisEncoder();
  const bytes: number[] = [];
  for (const ch of Array.from(text)) {
    const b = table.get(ch);
    if (!b) return null;
    bytes.push(...b);
  }
  return new Uint8Array(bytes);
}

/** All occurrences of `needle` in `hay` (naive with first-byte skip; hay is a few MiB at most). */
export function findBytes(hay: Uint8Array, needle: Uint8Array, max = 64): number[] {
  const out: number[] = [];
  if (!needle.length || hay.length < needle.length) return out;
  const first = needle[0];
  outer: for (let i = 0; i <= hay.length - needle.length && out.length < max; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    out.push(i);
  }
  return out;
}

export interface SearchRegion { start: number; bytes: Uint8Array }

/**
 * Search `text` in the given regions (guest address of region start + its bytes) in all
 * encodings. Returns hits sorted: string starts first, then by address.
 */
export function findText(text: string, regions: readonly SearchRegion[], opts: { encodings?: TextEncoding[]; max?: number } = {}): TextHit[] {
  const t = text.trim();
  if (Array.from(t).length < 2) return [];
  const encs = opts.encodings ?? ['shift_jis', 'utf-8', 'utf-16le'];
  const hits: TextHit[] = [];
  for (const enc of encs) {
    const needle = encodeText(t, enc);
    if (!needle) continue;
    for (const r of regions) {
      for (const off of findBytes(r.bytes, needle, opts.max ?? 64)) {
        const address = r.start + off;
        const prevZero = off === 0 || r.bytes[off - 1] === 0 || (enc === 'utf-16le' && off >= 2 && r.bytes[off - 1] === 0 && r.bytes[off - 2] === 0);
        hits.push({ address, encoding: enc, length: needle.length, preview: previewAt(r.bytes, off, needle.length, enc), atStringStart: prevZero });
      }
    }
  }
  return hits.sort((a, b) => Number(b.atStringStart) - Number(a.atStringStart) || a.address - b.address).slice(0, opts.max ?? 64);
}

function previewAt(bytes: Uint8Array, off: number, len: number, enc: TextEncoding): string {
  // extend to the string's start/end (NUL) within a window
  let s = off, e = off + len;
  const step = enc === 'utf-16le' ? 2 : 1;
  const isNul = (i: number) => (step === 1 ? bytes[i] === 0 : bytes[i] === 0 && bytes[i + 1] === 0);
  while (s - step >= 0 && off - s < 96 && !isNul(s - step)) s -= step;
  while (e + step <= bytes.length && e - off < 160 && !isNul(e)) e += step;
  // Prefer a strictly decodable window: shrink from the front (before the match) until the
  // decoder accepts it — bytes before a string are often binary, not text.
  let dec: TextDecoder;
  try {
    dec = new TextDecoder(enc, { fatal: true });
  } catch {
    return '';
  }
  for (let start = s; start <= off; start += step) {
    try {
      return dec.decode(bytes.subarray(start, e)).replace(/[\u0000-\u001f]/g, '·');
    } catch {
      /* try a shorter prefix */
    }
  }
  try {
    return new TextDecoder(enc).decode(bytes.subarray(off, e));
  } catch {
    return '';
  }
}

/** Given the start of a NUL-terminated string at `address`, suggest a watch size (≥ 64, ≤ 1024). */
export function suggestWatchSize(bytesFromAddress: Uint8Array, enc: TextEncoding): number {
  let n = 0;
  if (enc === 'utf-16le') {
    while (n + 1 < bytesFromAddress.length && (bytesFromAddress[n] !== 0 || bytesFromAddress[n + 1] !== 0)) n += 2;
  } else {
    while (n < bytesFromAddress.length && bytesFromAddress[n] !== 0) n++;
  }
  return Math.min(1024, Math.max(64, Math.ceil((n * 2 + 16) / 16) * 16));
}

/** Produce a ready-to-run script watching `address`. */
export function watchScriptFor(address: number, enc: TextEncoding, size: number, header: { discId?: string | null; title?: string | null }): string {
  const reader = enc === 'utf-16le' ? 'readUtf16String' : enc === 'utf-8' ? 'readUtf8String' : 'readShiftJisString';
  return `// ==UserScript==
// @name         [${header.discId ?? 'DISCID'}] ${header.title ?? 'Game'}
// @version      0.1
// @description  PPSSPP (web) — text hook generated by the memory text finder
// ==/UserScript==
const { setWatch } = require('./libPPSSPP.js');

// Address where this game keeps the dialogue line (${enc}); found by searching for on-screen text.
const TEXT_ADDR = 0x${address.toString(16).padStart(8, '0')};

setWatch({ [TEXT_ADDR]: trans.send(handler, '200++') }, { size: ${size}, intervalMs: 50 });

function handler(regs) {
  const s = regs[0].value.${reader}();
  return s && s.trim() ? s : null;
}

trans.replace(function (s) {
  return s.replace(/\\r?\\n/g, '').trim();
});
`;
}
