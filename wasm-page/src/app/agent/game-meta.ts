/**
 * Game identity from the image file: disc ID (e.g. ULJM05054) and title, read from
 * PARAM.SFO — inside the PBP header for EBOOT.PBP, or at PSP_GAME/PARAM.SFO in an ISO9660
 * image. The emulator exposes neither to JS; text-hook scripts are keyed by disc ID
 * (Agent's `[ULJM05054] Title` headers), so this drives script auto-selection.
 *
 * Pure: takes a `BlobLike` with `slice()`/`arrayBuffer()` so it is unit-testable on
 * synthetic images and reads only the sectors it needs (never the whole ISO).
 */

export interface GameMeta {
  discId: string | null;
  title: string | null;
  /** Where the SFO came from. */
  source: 'pbp' | 'iso' | 'none';
  /** Other SFO string fields, for display/debugging. */
  fields: Record<string, string | number>;
}

export interface BlobLike {
  readonly size: number;
  readonly name?: string;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

const SECTOR = 2048;

export async function readGameMeta(file: BlobLike): Promise<GameMeta> {
  const none: GameMeta = { discId: null, title: null, source: 'none', fields: {} };
  if (!file || file.size < 64) return none;
  const head = new Uint8Array(await file.slice(0, 0x28).arrayBuffer());
  const magic = String.fromCharCode(head[0], head[1], head[2], head[3]);
  if (magic === '\0PBP') {
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const sfoOff = dv.getUint32(0x08, true);
    const iconOff = dv.getUint32(0x0c, true);
    if (iconOff > sfoOff && iconOff - sfoOff < 1 << 20) {
      const sfo = new Uint8Array(await file.slice(sfoOff, iconOff).arrayBuffer());
      return { ...fromSfo(parseSfo(sfo)), source: 'pbp' };
    }
    return none;
  }
  // ISO9660: primary volume descriptor at sector 16
  if (file.size < 17 * SECTOR) return none;
  const pvd = new Uint8Array(await file.slice(16 * SECTOR, 17 * SECTOR).arrayBuffer());
  if (!(pvd[0] === 1 && String.fromCharCode(...pvd.subarray(1, 6)) === 'CD001')) return none;
  const rootRec = pvd.subarray(156, 156 + 34);
  const root = dirRecord(rootRec, 0);
  if (!root) return none;
  const gameDir = await findEntry(file, root.extent, root.size, 'PSP_GAME', true);
  if (!gameDir) return none;
  const sfoEntry = await findEntry(file, gameDir.extent, gameDir.size, 'PARAM.SFO', false);
  if (!sfoEntry || sfoEntry.size > 1 << 20) return none;
  const sfo = new Uint8Array(await file.slice(sfoEntry.extent * SECTOR, sfoEntry.extent * SECTOR + sfoEntry.size).arrayBuffer());
  return { ...fromSfo(parseSfo(sfo)), source: 'iso' };
}

interface DirRec { length: number; extent: number; size: number; flags: number; name: string }

function dirRecord(b: Uint8Array, off: number): DirRec | null {
  const length = b[off];
  if (!length || off + length > b.length) return null;
  const dv = new DataView(b.buffer, b.byteOffset + off, length);
  const extent = dv.getUint32(2, true);
  const size = dv.getUint32(10, true);
  const flags = b[off + 25];
  const nameLen = b[off + 32];
  let name = '';
  for (let i = 0; i < nameLen; i++) name += String.fromCharCode(b[off + 33 + i]);
  name = name.replace(/;\d+$/, ''); // strip version ";1"
  return { length, extent, size, flags, name };
}

async function findEntry(file: BlobLike, extent: number, size: number, wanted: string, dir: boolean): Promise<DirRec | null> {
  const bytes = new Uint8Array(await file.slice(extent * SECTOR, extent * SECTOR + Math.min(size, 64 * SECTOR)).arrayBuffer());
  let off = 0;
  while (off < bytes.length) {
    const rec = dirRecord(bytes, off);
    if (!rec) {
      // records never cross a sector boundary; skip padding to the next sector
      off = (Math.floor(off / SECTOR) + 1) * SECTOR;
      continue;
    }
    const isDir = (rec.flags & 2) !== 0;
    if (rec.name.toUpperCase() === wanted && isDir === dir) return rec;
    off += rec.length;
  }
  return null;
}

/** Parse a PARAM.SFO (PSF) into its key/value table. */
export function parseSfo(b: Uint8Array): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (b.length < 20 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== '\0PSF') return out;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const keyTable = dv.getUint32(0x08, true);
  const dataTable = dv.getUint32(0x0c, true);
  const count = dv.getUint32(0x10, true);
  for (let i = 0; i < Math.min(count, 256); i++) {
    const e = 0x14 + i * 16;
    if (e + 16 > b.length) break;
    const keyOff = dv.getUint16(e, true);
    const fmt = dv.getUint16(e + 2, true);
    const len = dv.getUint32(e + 4, true);
    const dataOff = dv.getUint32(e + 12, true);
    let key = '';
    for (let k = keyTable + keyOff; k < b.length && b[k] !== 0; k++) key += String.fromCharCode(b[k]);
    const start = dataTable + dataOff;
    if (start + len > b.length) continue;
    if (fmt === 0x0404) out[key] = dv.getUint32(start, true);
    else {
      const raw = b.subarray(start, start + len);
      const z = raw.indexOf(0);
      out[key] = utf8(z >= 0 ? raw.subarray(0, z) : raw);
    }
  }
  return out;
}

function utf8(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8').decode(b);
  } catch {
    return String.fromCharCode(...b);
  }
}

function fromSfo(f: Record<string, string | number>): Omit<GameMeta, 'source'> {
  const disc = typeof f['DISC_ID'] === 'string' ? (f['DISC_ID'] as string).trim() : null;
  const title = typeof f['TITLE'] === 'string' ? (f['TITLE'] as string).trim() : null;
  return { discId: disc && /^[A-Z]{4}\d{5}$/.test(disc) ? disc : disc || null, title: title || null, fields: f };
}

/**
 * Disc-ID-like tokens in a script's header name, e.g. "[ULJM05054] Kin'iro no Corda" or
 * "PSP_ULJM06302-3_…" → ["ULJM05054"]. Handles "ULJM06302-3" as both 06302 and 06303.
 */
export function discIdsInText(text: string): string[] {
  const out = new Set<string>();
  // not \b: underscores are word characters and file names look like PSP_ULJM06302-3_Title.js
  for (const m of text.matchAll(/(?<![A-Z0-9])([A-Z]{4})(\d{5})(?:-(\d{1,2}))?(?![A-Z0-9])/g)) {
    out.add(m[1] + m[2]);
    if (m[3]) {
      const base = m[2];
      const suffix = m[3];
      out.add(m[1] + base.slice(0, base.length - suffix.length) + suffix);
    }
  }
  return Array.from(out);
}
