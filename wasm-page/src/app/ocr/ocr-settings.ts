/**
 * Persisted OCR settings. Uses its own localStorage keys; never touches the
 * emulator's OPFS saves, ROM storage or the model cache (owned by meikiocr-web).
 */
import { DEFAULT_OCR_SETTINGS, type GamePrefs, type OcrSettings } from './ocr-types';

export const OCR_SETTINGS_KEY = 'ppsspp_ocr_settings_v1';
export const OCR_GAME_PREFS_KEY = 'ppsspp_ocr_game_prefs_v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadSettings(storage: StorageLike): OcrSettings {
  try {
    const raw = storage.getItem(OCR_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_OCR_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<OcrSettings> & { schemaVersion?: number };
    if (parsed.schemaVersion !== 1) return { ...DEFAULT_OCR_SETTINGS };
    return sanitize({ ...DEFAULT_OCR_SETTINGS, ...parsed, schemaVersion: 1 });
  } catch {
    return { ...DEFAULT_OCR_SETTINGS };
  }
}

export function saveSettings(storage: StorageLike, s: OcrSettings): void {
  storage.setItem(OCR_SETTINGS_KEY, JSON.stringify(sanitize(s)));
}

export function resetSettings(storage: StorageLike): void {
  storage.removeItem(OCR_SETTINGS_KEY);
  storage.removeItem(OCR_GAME_PREFS_KEY);
}

export function sanitize(s: OcrSettings): OcrSettings {
  const out: OcrSettings = { ...s };
  out.scanIntervalMs = clampNum(out.scanIntervalMs, 100, 10_000, DEFAULT_OCR_SETTINGS.scanIntervalMs);
  out.wasmThreads = clampNum(Math.round(out.wasmThreads), 1, 8, 1);
  out.maxCapturePixels = clampNum(out.maxCapturePixels, 65_536, 4_000_000, DEFAULT_OCR_SETTINGS.maxCapturePixels);
  out.fontScale = clampNum(out.fontScale, 0.5, 3, 1);
  if (!['source-aligned', 'popup'].includes(out.presentation)) out.presentation = 'source-aligned';
  if (!['remove', 'mark', 'off'].includes(out.stalePolicy)) out.stalePolicy = 'mark';
  if (!['line-text', 'glyph-spans'].includes(out.textLayerStrategy)) out.textLayerStrategy = 'line-text';
  if (!['visual_novel_mode', 'flip_horizontally', 'flip_vertically', 'flip_both'].includes(out.popupPositionMode)) {
    out.popupPositionMode = 'visual_novel_mode';
  }
  if (!['meikipop-v2', 'meikiocr-native'].includes(out.ocrProfile)) out.ocrProfile = 'meikipop-v2';
  if (!['wasm', 'webgpu'].includes(out.ocrBackend)) out.ocrBackend = 'wasm';
  out.hotkey = normalizeHotkey(out.hotkey);
  return out;
}

export function normalizeHotkey(k: string): string {
  const v = (k || 'shift').toLowerCase().trim();
  return ['shift', 'control', 'alt', 'meta', 'none'].includes(v) ? v : 'shift';
}

function clampNum(v: number, lo: number, hi: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

// ── per-game preferences ──

type PrefsMap = Record<string, GamePrefs>;

function loadMap(storage: StorageLike): PrefsMap {
  try {
    const raw = storage.getItem(OCR_GAME_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as PrefsMap) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function loadGamePrefs(storage: StorageLike, gameId: string | null): GamePrefs | null {
  if (!gameId) return null;
  return loadMap(storage)[gameKey(gameId)] ?? null;
}

export function saveGamePrefs(storage: StorageLike, gameId: string | null, prefs: GamePrefs): void {
  if (!gameId) return;
  const map = loadMap(storage);
  map[gameKey(gameId)] = prefs;
  // Keep the record bounded: drop oldest entries beyond 200.
  const keys = Object.keys(map);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete map[k];
  storage.setItem(OCR_GAME_PREFS_KEY, JSON.stringify(map));
}

/**
 * Game identity key. Disc IDs (e.g. ULJM05500) are preferred; a file-name
 * fallback is namespaced so it can never collide with a disc ID.
 */
export function gameKey(gameId: string): string {
  return /^[A-Z]{4}\d{5}$/.test(gameId) ? `disc:${gameId}` : `file:${gameId}`;
}
