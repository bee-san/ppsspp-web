import { describe, expect, it } from 'vitest';
import { gameKey, loadGamePrefs, loadSettings, normalizeHotkey, resetSettings, saveGamePrefs, saveSettings, sanitize, type StorageLike } from './ocr-settings';
import { DEFAULT_OCR_SETTINGS } from './ocr-types';

function mem(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

describe('ocr settings store', () => {
  it('defaults mirror MeikiPop for the five behaviour values', () => {
    expect(DEFAULT_OCR_SETTINGS.autoScan).toBe(true);
    expect(DEFAULT_OCR_SETTINGS.lookupsWithoutHotkey).toBe(true);
    expect(DEFAULT_OCR_SETTINGS.scanOnMouseMove).toBe(true);
    expect(DEFAULT_OCR_SETTINGS.scanIntervalMs).toBe(500);
    expect(DEFAULT_OCR_SETTINGS.hotkey).toBe('shift');
    expect(DEFAULT_OCR_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_OCR_SETTINGS.modelDownloadConsent).toBe(false);
  });

  it('defaults: invisible exact per-character layer (MeikiPop-like)', () => {
    expect(DEFAULT_OCR_SETTINGS.overlayTextVisible).toBe(false);
    expect(DEFAULT_OCR_SETTINGS.textLayerStrategy).toBe('glyph-spans');
    expect(DEFAULT_OCR_SETTINGS.schemaVersion).toBe(2);
  });

  it('migrates v1: old default line-text → glyph-spans, other choices kept, layer invisible', () => {
    const st = mem();
    st.setItem('ppsspp_ocr_settings_v1', JSON.stringify({ schemaVersion: 1, enabled: true, modelDownloadConsent: true, textLayerStrategy: 'line-text', hotkey: 'alt', scanIntervalMs: 800, overlayTextVisible: true }));
    const s = loadSettings(st);
    expect(s.schemaVersion).toBe(2);
    expect(s.textLayerStrategy).toBe('glyph-spans');
    expect(s.overlayTextVisible).toBe(false);
    expect(s.enabled).toBe(true);
    expect(s.modelDownloadConsent).toBe(true);
    expect(s.hotkey).toBe('alt');
    expect(s.scanIntervalMs).toBe(800);
    // an explicit v1 glyph-spans choice is untouched
    st.setItem('ppsspp_ocr_settings_v1', JSON.stringify({ schemaVersion: 1, textLayerStrategy: 'glyph-spans' }));
    expect(loadSettings(st).textLayerStrategy).toBe('glyph-spans');
  });

  it('round-trips and ignores unknown schema versions', () => {
    const st = mem();
    saveSettings(st, { ...DEFAULT_OCR_SETTINGS, enabled: true, scanIntervalMs: 700 });
    expect(loadSettings(st).scanIntervalMs).toBe(700);
    st.setItem('ppsspp_ocr_settings_v1', JSON.stringify({ schemaVersion: 99, scanIntervalMs: 5 }));
    expect(loadSettings(st)).toEqual(DEFAULT_OCR_SETTINGS);
    st.setItem('ppsspp_ocr_settings_v1', '{not json');
    expect(loadSettings(st)).toEqual(DEFAULT_OCR_SETTINGS);
  });

  it('sanitizes out-of-range and invalid values', () => {
    const s = sanitize({ ...DEFAULT_OCR_SETTINGS, scanIntervalMs: 1, wasmThreads: 99, presentation: 'x' as never, hotkey: 'F13', ocrProfile: 'nope' as never });
    expect(s.scanIntervalMs).toBe(100);
    expect(s.wasmThreads).toBe(8);
    expect(s.presentation).toBe('source-aligned');
    expect(s.hotkey).toBe('shift');
    expect(s.ocrProfile).toBe('meikipop-v2');
    expect(normalizeHotkey('CONTROL')).toBe('control');
  });

  it('per-game prefs are namespaced so file names never collide with disc ids', () => {
    expect(gameKey('ULJM05500')).toBe('disc:ULJM05500');
    expect(gameKey('ULJM05500.iso')).toBe('file:ULJM05500.iso');
    const st = mem();
    saveGamePrefs(st, 'ULJM05500', { region: { x: 0.1, y: 0.6, w: 0.8, h: 0.3 } });
    expect(loadGamePrefs(st, 'ULJM05500')?.region?.y).toBe(0.6);
    expect(loadGamePrefs(st, 'ULJM05500.iso')).toBeNull();
    expect(loadGamePrefs(st, null)).toBeNull();
  });

  it('reset removes only OCR keys', () => {
    const st = mem();
    st.setItem('ppsspp_touch_mouse_fallback', '1');
    saveSettings(st, DEFAULT_OCR_SETTINGS);
    saveGamePrefs(st, 'X', { region: null });
    resetSettings(st);
    expect([...st.map.keys()]).toEqual(['ppsspp_touch_mouse_fallback']);
  });
});
