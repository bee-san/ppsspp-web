import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../ocr/ocr-settings';
import {
  MINING_SETTINGS_KEY,
  describeHotkey,
  hotkeyMatches,
  loadMiningSettings,
  normalizeAnkiUrl,
  normalizeMiningHotkey,
  resetMiningSettings,
  sanitizeMiningSettings,
  saveMiningSettings,
} from './mining-settings';
import { DEFAULT_MINING_SETTINGS } from './mining-types';

function mem(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

describe('mining settings store', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_MINING_SETTINGS.enabled).toBe(true);
    expect(DEFAULT_MINING_SETTINGS.hotkey).toEqual({ key: '§', code: '' });
    expect(DEFAULT_MINING_SETTINGS.bufferSeconds).toBe(20);
    expect(DEFAULT_MINING_SETTINGS.defaultClipSeconds).toBe(8);
    expect(DEFAULT_MINING_SETTINGS.imageMode).toBe('animated');
    expect(DEFAULT_MINING_SETTINGS.imageFps).toBe(8);
    expect(DEFAULT_MINING_SETTINGS.imageMaxWidth).toBe(480);
    expect(DEFAULT_MINING_SETTINGS.imageQuality).toBe(0.8);
    expect(DEFAULT_MINING_SETTINGS.audioBitrateKbps).toBe(96);
    expect(DEFAULT_MINING_SETTINGS.ankiUrl).toBe('http://127.0.0.1:8765');
    expect(DEFAULT_MINING_SETTINGS.audioField).toBe('SentenceAudio');
    expect(DEFAULT_MINING_SETTINGS.pictureField).toBe('Picture');
    expect(DEFAULT_MINING_SETTINGS.tag).toBe('ppsspp-web');
    expect(DEFAULT_MINING_SETTINGS.showPicker).toBe(true);
  });

  it('round-trips and ignores unknown schema versions / bad JSON', () => {
    const st = mem();
    saveMiningSettings(st, { ...DEFAULT_MINING_SETTINGS, bufferSeconds: 30, tag: 'x y' });
    const loaded = loadMiningSettings(st);
    expect(loaded.bufferSeconds).toBe(30);
    expect(loaded.tag).toBe('x_y');
    st.setItem(MINING_SETTINGS_KEY, JSON.stringify({ schemaVersion: 7, bufferSeconds: 5 }));
    expect(loadMiningSettings(st)).toEqual(DEFAULT_MINING_SETTINGS);
    st.setItem(MINING_SETTINGS_KEY, '{nope');
    expect(loadMiningSettings(st)).toEqual(DEFAULT_MINING_SETTINGS);
    st.setItem(MINING_SETTINGS_KEY, 'null');
    expect(loadMiningSettings(st)).toEqual(DEFAULT_MINING_SETTINGS);
  });

  it('clamps numeric ranges and keeps the clip within the buffer', () => {
    const s = sanitizeMiningSettings({
      ...DEFAULT_MINING_SETTINGS,
      bufferSeconds: 999,
      defaultClipSeconds: 500,
      imageFps: 1,
      imageMaxWidth: 10_000,
      imageQuality: 2,
      audioBitrateKbps: 77,
    });
    expect(s.bufferSeconds).toBe(60);
    expect(s.defaultClipSeconds).toBe(60);
    expect(s.imageFps).toBe(4);
    expect(s.imageMaxWidth).toBe(960);
    expect(s.imageQuality).toBe(0.95);
    expect(s.audioBitrateKbps).toBe(96);

    const small = sanitizeMiningSettings({ ...DEFAULT_MINING_SETTINGS, bufferSeconds: 5, defaultClipSeconds: NaN });
    expect(small.bufferSeconds).toBe(5);
    expect(small.defaultClipSeconds).toBe(5);
  });

  it('falls back on invalid enums, strings and URLs', () => {
    const s = sanitizeMiningSettings({
      ...DEFAULT_MINING_SETTINGS,
      imageMode: 'gif' as never,
      audioField: '   ',
      pictureField: 42 as never,
      ankiUrl: 'ftp://nope',
      enabled: 'yes' as never,
    });
    expect(s.imageMode).toBe('animated');
    expect(s.audioField).toBe('SentenceAudio');
    expect(s.pictureField).toBe('Picture');
    expect(s.ankiUrl).toBe('http://127.0.0.1:8765');
    expect(s.enabled).toBe(true);
    expect(normalizeAnkiUrl('http://localhost:8765/// ')).toBe('http://localhost:8765');
    expect(normalizeAnkiUrl('https://anki.example:8765')).toBe('https://anki.example:8765');
  });

  it('normalises hotkeys from objects, strings and garbage', () => {
    expect(normalizeMiningHotkey({ key: 'F9', code: 'F9' })).toEqual({ key: 'F9', code: 'F9' });
    expect(normalizeMiningHotkey({ key: '', code: 'Backquote' })).toEqual({ key: '', code: 'Backquote' });
    expect(normalizeMiningHotkey('m')).toEqual({ key: 'm', code: '' });
    expect(normalizeMiningHotkey('   ')).toEqual({ key: '§', code: '' });
    expect(normalizeMiningHotkey(null)).toEqual({ key: '§', code: '' });
    expect(normalizeMiningHotkey({ key: 3, code: 4 })).toEqual({ key: '§', code: '' });
  });

  it('matches by code when recorded, else by key', () => {
    expect(hotkeyMatches({ key: '§', code: '' }, { key: '§', code: 'Backquote' })).toBe(true);
    expect(hotkeyMatches({ key: '§', code: '' }, { key: '`', code: 'Backquote' })).toBe(false);
    expect(hotkeyMatches({ key: '§', code: 'Backquote' }, { key: '`', code: 'Backquote' })).toBe(true);
    expect(hotkeyMatches({ key: '§', code: 'Backquote' }, { key: '§', code: 'IntlBackslash' })).toBe(false);
    expect(hotkeyMatches({ key: '', code: '' }, { key: '', code: '' })).toBe(false);
  });

  it('describes hotkeys for the UI', () => {
    expect(describeHotkey({ key: '§', code: 'Backquote' })).toBe('§');
    expect(describeHotkey({ key: ' ', code: 'Space' })).toBe('Space');
    expect(describeHotkey({ key: 'Dead', code: 'Backquote' })).toBe('Backquote');
    expect(describeHotkey({ key: '', code: '' })).toBe('—');
  });

  it('reset removes only the mining key', () => {
    const st = mem();
    st.setItem('ppsspp_ocr_settings_v1', '{}');
    saveMiningSettings(st, DEFAULT_MINING_SETTINGS);
    resetMiningSettings(st);
    expect([...st.map.keys()]).toEqual(['ppsspp_ocr_settings_v1']);
  });
});
