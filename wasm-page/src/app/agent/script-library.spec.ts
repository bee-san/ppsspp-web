import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discIdsInText, parseSfo, readGameMeta, type BlobLike } from './game-meta';
import { analyzeScript, loadLibrary, parseCatalog, saveLibrary, scriptFromSource, scriptsForDisc, searchCatalog } from './script-library';

function blob(bytes: Uint8Array, name = 'x'): BlobLike {
  return { size: bytes.length, name, slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer as ArrayBuffer }) };
}

/** Build a minimal PARAM.SFO with the given string fields. */
function makeSfo(fields: Record<string, string>): Uint8Array {
  const keys = Object.keys(fields);
  const enc = new TextEncoder();
  const keyBytes = keys.map((k) => enc.encode(k + '\0'));
  const dataBytes = keys.map((k) => { const v = enc.encode(fields[k] + '\0'); const padded = new Uint8Array(Math.ceil(v.length / 4) * 4); padded.set(v); return padded; });
  const header = 0x14, entries = keys.length * 16;
  const keyTable = header + entries;
  const keyTableLen = keyBytes.reduce((n, b) => n + b.length, 0);
  const dataTable = Math.ceil((keyTable + keyTableLen) / 4) * 4;
  const total = dataTable + dataBytes.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total); const dv = new DataView(out.buffer);
  out.set([0, 0x50, 0x53, 0x46]); dv.setUint32(4, 0x0101, true); dv.setUint32(8, keyTable, true); dv.setUint32(12, dataTable, true); dv.setUint32(16, keys.length, true);
  let ko = 0, doff = 0;
  keys.forEach((_, i) => { const e = header + i * 16; dv.setUint16(e, ko, true); dv.setUint16(e + 2, 0x0204, true); dv.setUint32(e + 4, dataBytes[i].length, true); dv.setUint32(e + 8, dataBytes[i].length, true); dv.setUint32(e + 12, doff, true); out.set(keyBytes[i], keyTable + ko); out.set(dataBytes[i], dataTable + doff); ko += keyBytes[i].length; doff += dataBytes[i].length; });
  return out;
}

function makePbp(sfo: Uint8Array): Uint8Array {
  const out = new Uint8Array(0x28 + sfo.length + 16); const dv = new DataView(out.buffer);
  out.set([0, 0x50, 0x42, 0x50]); dv.setUint32(4, 0x10000, true);
  const offs = [0x28, 0x28 + sfo.length, 0x28 + sfo.length, 0x28 + sfo.length, 0x28 + sfo.length, 0x28 + sfo.length, 0x28 + sfo.length + 16, 0x28 + sfo.length + 16];
  offs.forEach((o, i) => dv.setUint32(8 + i * 4, o, true));
  out.set(sfo, 0x28);
  return out;
}

/** Minimal ISO9660: PVD at sector 16, root dir at sector 18 with PSP_GAME at 19, PARAM.SFO at 20. */
function makeIso(sfo: Uint8Array): Uint8Array {
  const S = 2048; const out = new Uint8Array(21 * S);
  const rec = (at: number, extent: number, size: number, flags: number, name: string) => { const n = new TextEncoder().encode(name); const len = 33 + n.length + ((33 + n.length) % 2); out[at] = len; new DataView(out.buffer).setUint32(at + 2, extent, true); new DataView(out.buffer).setUint32(at + 10, size, true); out[at + 25] = flags; out[at + 32] = n.length; out.set(n, at + 33); return len; };
  const pvd = 16 * S; out[pvd] = 1; out.set(new TextEncoder().encode('CD001'), pvd + 1);
  rec(pvd + 156, 18, S, 2, '\0');
  let o = 18 * S; o += rec(o, 18, S, 2, '\0'); o += rec(o, 17, S, 2, '\x01'); o += rec(o, 19, S, 2, 'PSP_GAME'); rec(o, 17, 5, 0, 'UMD_DATA.BIN;1');
  o = 19 * S; o += rec(o, 19, S, 2, '\0'); o += rec(o, 18, S, 2, '\x01'); o += rec(o, 20, sfo.length, 0, 'PARAM.SFO;1'); rec(o, 17, 4, 2, 'USRDIR');
  out.set(sfo, 20 * S);
  return out;
}

describe('game metadata', () => {
  it('parses PARAM.SFO string fields', () => {
    const f = parseSfo(makeSfo({ DISC_ID: 'ULJM05054', TITLE: "Kin'iro no Corda", CATEGORY: 'UG' }));
    expect(f['DISC_ID']).toBe('ULJM05054');
    expect(f['TITLE']).toBe("Kin'iro no Corda");
    expect(parseSfo(new Uint8Array(8))).toEqual({});
  });
  it('reads the disc ID from an EBOOT.PBP header and from PSP_GAME/PARAM.SFO in an ISO', async () => {
    const sfo = makeSfo({ DISC_ID: 'NPJH50127', TITLE: 'ときめきメモリアル4' });
    const pbp = await readGameMeta(blob(makePbp(sfo), 'EBOOT.PBP'));
    expect(pbp).toMatchObject({ discId: 'NPJH50127', title: 'ときめきメモリアル4', source: 'pbp' });
    const iso = await readGameMeta(blob(makeIso(sfo), 'game.iso'));
    expect(iso).toMatchObject({ discId: 'NPJH50127', title: 'ときめきメモリアル4', source: 'iso' });
    expect((await readGameMeta(blob(new Uint8Array(40000)))).source).toBe('none');
  });
  it('reads the bundled test game EBOOT (real file)', async () => {
    const bytes = new Uint8Array(readFileSync(resolve('test-game/EBOOT.PBP')));
    const m = await readGameMeta(blob(bytes, 'EBOOT.PBP'));
    expect(m.source).toBe('pbp');
    expect(m.title).toBe('JP Text Alignment Test');
    expect(m.discId).toBe('JPTX00001'); // set via SFOFLAGS in test-game/Makefile; the bundled script is keyed on it
  });
  it('finds disc IDs in Agent headers and file names, expanding ULJM06302-3', () => {
    expect(discIdsInText("[ULJM05054] Kin'iro no Corda")).toEqual(['ULJM05054']);
    expect(discIdsInText('PSP_ULJM06302-3_Seishun_Hajimemashita.js').sort()).toEqual(['ULJM06302', 'ULJM06303']);
    expect(discIdsInText('no ids here')).toEqual([]);
  });
});

describe('script library', () => {
  const SRC = "// ==UserScript==\n// @name         [ULJM05054] Kin'iro no Corda\n// @version      0.1\n// @author       [DC]\n// ==/UserScript==\nconst { setHook } = require('./libPPSSPP.js');\nsetHook({ 0x886162c: function () {} });\n";
  it('builds a library entry from source (name, disc ids, meta) and matches by disc', () => {
    const sc = scriptFromSource(SRC, 'community', { url: 'https://x/PSP_ULJM05054_Kiniro_no_Corda.js', fileName: 'PSP_ULJM05054_Kiniro_no_Corda.js' });
    expect(sc.name).toBe("[ULJM05054] Kin'iro no Corda");
    expect(sc.discIds).toEqual(['ULJM05054']);
    expect(sc.meta['author']).toBe('[DC]');
    expect(scriptsForDisc([sc], 'ULJM05054')).toEqual([sc]);
    expect(scriptsForDisc([sc], 'ULJM05055')).toEqual([]);
    expect(scriptsForDisc([sc], null)).toEqual([]);
  });
  it('persists user/community scripts but not bundled ones', () => {
    const m = new Map<string, string>(); const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    const user = scriptFromSource(SRC, 'user'); const bundled = scriptFromSource('// x', 'bundled', { id: 'bundled:x' });
    saveLibrary(st, [bundled, user]);
    expect(loadLibrary(st).map((s) => s.id)).toEqual([user.id]);
    m.set('ppsspp_agent_library_v1', 'not json');
    expect(loadLibrary(st)).toEqual([]);
  });
  it('parses the GitHub listing into PSP catalog entries and searches it', () => {
    const listing = [
      { name: 'PSP_ULJM05054_Kiniro_no_Corda.js', type: 'file', size: 1566, download_url: 'https://raw.githubusercontent.com/0xDC00/scripts/main/PSP_ULJM05054_Kiniro_no_Corda.js' },
      { name: 'PSP_ULJM06302-3_Seishun_Hajimemashita.js', type: 'file', size: 900, download_url: 'https://raw/x.js' },
      { name: '3DS_Japan_Exstetra.js', type: 'file', size: 1, download_url: 'https://raw/3ds.js' },
      { name: 'libPPSSPP.js', type: 'file', size: 1, download_url: 'https://raw/lib.js' },
      { name: 'HCode', type: 'dir' },
    ];
    const cat = parseCatalog(listing);
    expect(cat.map((c) => c.title)).toEqual(['Kiniro no Corda', 'Seishun Hajimemashita']);
    expect(cat[1].discIds.sort()).toEqual(['ULJM06302', 'ULJM06303']);
    expect(searchCatalog(cat, 'uljm06303').map((c) => c.title)).toEqual(['Seishun Hajimemashita']);
    expect(searchCatalog(cat, 'corda').length).toBe(1);
    expect(searchCatalog(cat, '').length).toBe(2);
    expect(parseCatalog({ message: 'rate limited' })).toEqual([]);
  });
  it('analyzes what a script needs', () => {
    expect(analyzeScript(SRC)).toMatchObject({ usesSetHook: true, usesSetWatch: false, requires: ['./libPPSSPP.js'] });
    expect(analyzeScript('setWatch({ 1: f })').usesSetWatch).toBe(true);
  });
});
