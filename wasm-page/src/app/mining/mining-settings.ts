/**
 * Persisted sentence-mining settings. Own localStorage key; never touches the
 * emulator's OPFS saves or the OCR keys.
 */
import type { StorageLike } from '../ocr/ocr-settings';
import { DEFAULT_MINING_SETTINGS, MINING_LIMITS, type MiningHotkey, type MiningSettings } from './mining-types';

export const MINING_SETTINGS_KEY = 'ppsspp_mining_settings_v1';

export function loadMiningSettings(storage: StorageLike): MiningSettings {
  try {
    const raw = storage.getItem(MINING_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_MINING_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<MiningSettings> & { schemaVersion?: number };
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) return { ...DEFAULT_MINING_SETTINGS };
    return sanitizeMiningSettings({ ...DEFAULT_MINING_SETTINGS, ...parsed, schemaVersion: 1 });
  } catch {
    return { ...DEFAULT_MINING_SETTINGS };
  }
}

export function saveMiningSettings(storage: StorageLike, s: MiningSettings): void {
  storage.setItem(MINING_SETTINGS_KEY, JSON.stringify(sanitizeMiningSettings(s)));
}

export function resetMiningSettings(storage: StorageLike): void {
  storage.removeItem(MINING_SETTINGS_KEY);
}

export function sanitizeMiningSettings(s: MiningSettings): MiningSettings {
  const d = DEFAULT_MINING_SETTINGS;
  const out: MiningSettings = { ...s, schemaVersion: 1 };
  out.enabled = typeof out.enabled === 'boolean' ? out.enabled : d.enabled;
  out.showPicker = typeof out.showPicker === 'boolean' ? out.showPicker : d.showPicker;
  out.showDiagnostics = typeof out.showDiagnostics === 'boolean' ? out.showDiagnostics : d.showDiagnostics;
  out.hotkey = normalizeMiningHotkey(out.hotkey);
  out.bufferSeconds = Math.round(clampNum(out.bufferSeconds, MINING_LIMITS.bufferSeconds.min, MINING_LIMITS.bufferSeconds.max, d.bufferSeconds));
  out.defaultClipSeconds = Math.round(clampNum(out.defaultClipSeconds, MINING_LIMITS.defaultClipSeconds.min, out.bufferSeconds, Math.min(d.defaultClipSeconds, out.bufferSeconds)));
  if (out.imageMode !== 'animated' && out.imageMode !== 'screenshot') out.imageMode = d.imageMode;
  out.imageFps = Math.round(clampNum(out.imageFps, MINING_LIMITS.imageFps.min, MINING_LIMITS.imageFps.max, d.imageFps));
  out.imageMaxWidth = Math.round(clampNum(out.imageMaxWidth, MINING_LIMITS.imageMaxWidth.min, MINING_LIMITS.imageMaxWidth.max, d.imageMaxWidth));
  out.imageQuality = clampNum(out.imageQuality, MINING_LIMITS.imageQuality.min, MINING_LIMITS.imageQuality.max, d.imageQuality);
  out.audioBitrateKbps = MINING_LIMITS.audioBitrateKbps.includes(out.audioBitrateKbps) ? out.audioBitrateKbps : d.audioBitrateKbps;
  out.ankiUrl = normalizeAnkiUrl(out.ankiUrl);
  out.audioField = str(out.audioField, d.audioField);
  out.pictureField = str(out.pictureField, d.pictureField);
  out.tag = typeof out.tag === 'string' ? out.tag.trim().replace(/\s+/g, '_') : d.tag;
  return out;
}

/** Accept `{key, code}`, legacy plain strings, or garbage → default. */
export function normalizeMiningHotkey(h: unknown): MiningHotkey {
  const d = DEFAULT_MINING_SETTINGS.hotkey;
  if (typeof h === 'string') return h.trim() ? { key: h.trim(), code: '' } : { ...d };
  if (!h || typeof h !== 'object') return { ...d };
  const o = h as Partial<MiningHotkey>;
  const key = typeof o.key === 'string' ? o.key : '';
  const code = typeof o.code === 'string' ? o.code : '';
  if (!key && !code) return { ...d };
  return { key, code };
}

/** Keep http(s) URLs only; strip trailing slashes; fall back to the default. */
export function normalizeAnkiUrl(u: unknown): string {
  if (typeof u !== 'string') return DEFAULT_MINING_SETTINGS.ankiUrl;
  const t = u.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(t)) return DEFAULT_MINING_SETTINGS.ankiUrl;
  return t;
}

/** Does this keyboard event match the configured hotkey? `code` wins when recorded. */
export function hotkeyMatches(h: MiningHotkey, e: { key: string; code: string }): boolean {
  if (h.code) return e.code === h.code;
  return !!h.key && e.key === h.key;
}

/** Human label for the settings UI. */
export function describeHotkey(h: MiningHotkey): string {
  if (h.key && h.key !== 'Unidentified' && h.key !== 'Dead') return h.key === ' ' ? 'Space' : h.key;
  return h.code || '—';
}

function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : dflt;
}

function clampNum(v: number, lo: number, hi: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}
