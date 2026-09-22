/**
 * Script library for text hooks: bundled scripts (shipped under agent-scripts/), user
 * scripts (pasted / file / imported from the Agent community repo), stored in localStorage
 * under one key, and matching a script to the running game by disc ID.
 *
 * Community catalog: https://github.com/0xDC00/scripts — the PSP scripts are files named
 * `PSP_<DISCID>_<Title>.js`; raw.githubusercontent.com serves them with CORS `*`, and the
 * GitHub contents API lists them (60 req/h unauthenticated — cached for a day).
 */
import type { StorageLike } from '../ocr/ocr-settings';
import { parseUserScriptHeader } from './agent-runtime-api';
import { discIdsInText } from './game-meta';

export interface LibraryScript {
  id: string;
  name: string;
  source: string;
  /** Disc IDs this script targets (from the header / file name). */
  discIds: string[];
  origin: 'bundled' | 'user' | 'community';
  /** For community scripts: the upstream URL (re-import / update). */
  url?: string;
  /** Header fields (@version, @author, @description). */
  meta: Record<string, string>;
  addedAt: number;
}

export interface CatalogEntry {
  fileName: string;
  discIds: string[];
  title: string;
  url: string;
  size: number;
}

export const AGENT_LIBRARY_KEY = 'ppsspp_agent_library_v1';
export const CATALOG_CACHE_KEY = 'ppsspp_agent_catalog_v1';
export const CATALOG_API = 'https://api.github.com/repos/0xDC00/scripts/contents/';
export const CATALOG_RAW = 'https://raw.githubusercontent.com/0xDC00/scripts/main/';

/** Bundled scripts (relative to the app base). */
export const BUNDLED_SCRIPTS: ReadonlyArray<{ id: string; path: string; name: string; discIds: string[] }> = [
  { id: 'bundled:test-game', path: 'agent-scripts/test-game.js', name: '[JPTX00001] JP Text Alignment Test (ppsspp-web test game)', discIds: ['JPTX00001'] },
];

export function scriptFromSource(source: string, origin: LibraryScript['origin'], opts: { id?: string; url?: string; fileName?: string; now?: number } = {}): LibraryScript {
  const meta = parseUserScriptHeader(source);
  const name = meta['name'] ?? (opts.fileName ? opts.fileName.replace(/\.js$/i, '') : 'Untitled script');
  const ids = new Set<string>([...discIdsInText(name), ...discIdsInText(opts.fileName ?? ''), ...discIdsInText(meta['description'] ?? '')]);
  return { id: opts.id ?? `${origin}:${hash(source)}`, name, source, discIds: Array.from(ids), origin, url: opts.url, meta, addedAt: opts.now ?? Date.now() };
}

export function loadLibrary(storage: StorageLike): LibraryScript[] {
  try {
    const raw = storage.getItem(AGENT_LIBRARY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is LibraryScript => !!x && typeof x === 'object' && typeof (x as LibraryScript).source === 'string' && typeof (x as LibraryScript).id === 'string').map((x) => ({ ...x, discIds: Array.isArray(x.discIds) ? x.discIds : [], meta: x.meta ?? {} }));
  } catch {
    return [];
  }
}

export function saveLibrary(storage: StorageLike, scripts: readonly LibraryScript[]): void {
  // bundled scripts are not persisted (they come from the app); keep user + community
  storage.setItem(AGENT_LIBRARY_KEY, JSON.stringify(scripts.filter((s) => s.origin !== 'bundled')));
}

/** Scripts whose disc IDs include `discId` (exact), most recently added first. */
export function scriptsForDisc(scripts: readonly LibraryScript[], discId: string | null): LibraryScript[] {
  if (!discId) return [];
  const id = discId.toUpperCase();
  return scripts.filter((s) => s.discIds.includes(id)).sort((a, b) => b.addedAt - a.addedAt);
}

/** Parse the GitHub contents listing into PSP catalog entries. */
export function parseCatalog(listing: unknown): CatalogEntry[] {
  if (!Array.isArray(listing)) return [];
  const out: CatalogEntry[] = [];
  for (const it of listing as Array<{ name?: string; download_url?: string; size?: number; type?: string }>) {
    if (!it || it.type !== 'file' || typeof it.name !== 'string' || !/^PSP_/i.test(it.name) || !/\.js$/i.test(it.name)) continue;
    const ids = discIdsInText(it.name);
    const title = it.name.replace(/^PSP_/i, '').replace(/\.js$/i, '').replace(/^[A-Z]{4}\d{5}(-\d+)?\s*_?/, '').replace(/[_-]+/g, ' ').trim();
    out.push({ fileName: it.name, discIds: ids, title, url: it.download_url ?? CATALOG_RAW + encodeURIComponent(it.name), size: it.size ?? 0 });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export interface CatalogCache { fetchedAt: number; entries: CatalogEntry[] }

export function loadCatalogCache(storage: StorageLike, maxAgeMs = 24 * 3600 * 1000, now = Date.now()): CatalogEntry[] | null {
  try {
    const raw = storage.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CatalogCache;
    if (!c || !Array.isArray(c.entries) || now - c.fetchedAt > maxAgeMs) return null;
    return c.entries;
  } catch {
    return null;
  }
}

export function saveCatalogCache(storage: StorageLike, entries: CatalogEntry[], now = Date.now()): void {
  storage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ fetchedAt: now, entries } satisfies CatalogCache));
}

/** Case-insensitive search over title, file name and disc IDs. */
export function searchCatalog(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice();
  return entries.filter((e) => e.title.toLowerCase().includes(q) || e.fileName.toLowerCase().includes(q) || e.discIds.some((d) => d.toLowerCase().includes(q)));
}

/**
 * Community scripts use `setHook(pc → handler)`; the browser runtime cannot break on code.
 * Report what a script needs so the UI can say so before the user wonders why nothing arrives.
 */
export function analyzeScript(source: string): { usesSetHook: boolean; usesSetWatch: boolean; usesInterceptor: boolean; requires: string[] } {
  const requires = Array.from(source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)).map((m) => m[1]);
  return { usesSetHook: /\bsetHook\s*\(/.test(source), usesSetWatch: /\bsetWatch\s*\(/.test(source), usesInterceptor: /\bInterceptor\.attach\s*\(/.test(source), requires };
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
