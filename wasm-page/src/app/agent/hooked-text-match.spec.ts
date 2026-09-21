import { describe, expect, it } from 'vitest';
import type { OcrGlyph, OcrLine, OcrSnapshot } from 'meikiocr-web';
import { applyHookedText, bestSubstring, normalizeForMatch, remapGlyphs, similarity } from './hooked-text-match';
import { DEFAULT_AGENT_SETTINGS, loadAgentSettings, sanitizeAgentSettings, saveAgentSettings } from './agent-types';

function line(id: string, text: string, x = 0, y = 0, cell = 10): OcrLine {
  const chars = Array.from(text);
  let u = 0;
  const glyphs: OcrGlyph[] = chars.map((c, i) => {
    const g: OcrGlyph = { id: `${id}:${i}`, text: c, box: [x + i * cell, y, x + (i + 1) * cell, y + cell], confidence: 0.9, utf16Start: u, utf16End: u + c.length };
    u += c.length;
    return g;
  });
  return { id, text, box: [x, y, x + chars.length * cell, y + cell], orientation: 'horizontal', glyphs };
}
function snap(lines: OcrLine[]): OcrSnapshot {
  return { frameId: 'f', width: 480, height: 272, profile: 'balanced' as never, lines, diagnostics: { backend: 'wasm', elapsedMs: 1, modelSetId: 'x', warnings: [] } as never };
}

describe('hooked text matching', () => {
  it('normalizes only for comparison', () => {
    expect(normalizeForMatch('ここは 静か な村だ．')).toBe('ここは静かな村だ。');
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abcd', 'abxd')).toBe(0.75);
  });

  it('finds each screen line inside one hooked two-line dialogue', () => {
    const hooked = 'ここは静かな村だ。北の森には古い神殿があるらしい。';
    expect(bestSubstring('ここは静かな村だ。', hooked, 0.5)?.text).toBe('ここは静かな村だ。');
    expect(bestSubstring('北の森には古い神殿があるらしい。', hooked, 0.5)?.text).toBe('北の森には古い神殿があるらしい。');
    // OCR misread 神殿 → 袖殿 and dropped the final 。: still the right substring
    const m = bestSubstring('北の森には古い袖殿があるらしい', hooked, 0.5);
    expect(m?.text).toBe('北の森には古い神殿があるらしい');
    expect(m!.score).toBeGreaterThan(0.85);
    // unrelated text: no match
    expect(bestSubstring('アイテム', hooked, 0.5)).toBeNull();
    // short lines are held to ≥ 0.75 even at threshold 0.5: 「アイテム」 must not become 「ライム」
    expect(bestSubstring('アイテム', 'スライムが現れた。どうする？', 0.5)).toBeNull();
    expect(bestSubstring('スライム', 'スライムが現れた。', 0.5)?.text).toBe('スライム');
  });

  it('replace mode swaps misread lines for the hooked text and keeps boxes; unmatched lines untouched', () => {
    const s = snap([line('a', '勇者の冒険'), line('b', '北の森には古い袖殿があるらしい', 0, 100), line('c', 'アイテム', 300, 50)]);
    const r = applyHookedText(s, ['前の行', 'ここは静かな村だ。北の森には古い神殿があるらしい。'], { threshold: 0.5, mode: 'replace' });
    expect(r.corrected).toEqual(['b']);
    const b = r.snapshot.lines[1];
    // misread fixed AND the trailing 。 the recognizer dropped is taken from the hooked text
    expect(b.text).toBe('北の森には古い神殿があるらしい。');
    expect(b.glyphs.map((g) => g.text).join('')).toBe(b.text);
    expect(b.glyphs.length).toBe(16);
    expect(b.glyphs[7].box).toEqual([70, 100, 80, 110]); // 神 sits where 袖 was
    expect(b.glyphs[15].box).toEqual([150, 100, 160, 110]); // synthesized cell after the last glyph
    expect(b.glyphs[15].text).toBe('。');
    expect(r.snapshot.lines[0]).toBe(s.lines[0]); // untouched objects are reused
    expect(r.snapshot.lines[2]).toBe(s.lines[2]);
  });

  it('appends dropped trailing punctuation (fullwidth ？) without disturbing recognized boxes', () => {
    const s = snap([line('q', 'どうする', 40, 224, 20)]);
    const r = applyHookedText(s, ['スライムが現れた。どうする？'], { threshold: 0.5, mode: 'replace' });
    expect(r.corrected).toEqual(['q']);
    expect(r.snapshot.lines[0].text).toBe('どうする？');
    expect(r.snapshot.lines[0].glyphs.slice(0, 4).map((g) => g.box)).toEqual(s.lines[0].glyphs.map((g) => g.box));
    expect(r.snapshot.lines[0].glyphs[4].box).toEqual([120, 224, 140, 244]);
    // a line that already ends with punctuation is not extended
    const s2 = snap([line('q', 'どうする？', 40, 224, 20)]);
    expect(applyHookedText(s2, ['スライムが現れた。どうする？'], { threshold: 0.5, mode: 'replace' }).corrected).toEqual([]);
  });

  it('does not touch a snapshot whose lines already equal the hooked text', () => {
    const s = snap([line('a', 'ここは静かな村だ。')]);
    const r = applyHookedText(s, ['ここは静かな村だ。北の森には古い神殿があるらしい。'], { threshold: 0.5, mode: 'replace' });
    expect(r.snapshot).toBe(s);
    expect(r.corrected).toEqual([]);
  });

  it('supplement mode keeps OCR text when only cosmetic differences exist; replace mode still normalizes them', () => {
    const s = snap([line('a', 'ここは静かな村だ．')]); // full stop variant
    const sup = applyHookedText(s, ['ここは静かな村だ。'], { threshold: 0.5, mode: 'supplement' });
    expect(sup.corrected).toEqual([]);
    const rep = applyHookedText(s, ['ここは静かな村だ。'], { threshold: 0.5, mode: 'replace' });
    expect(rep.corrected).toEqual(['a']);
    expect(rep.snapshot.lines[0].text).toBe('ここは静かな村だ。');
  });

  it('remaps glyph boxes proportionally when the character count differs', () => {
    const l = line('x', 'abcd'); // 4 boxes of 10px
    const g = remapGlyphs(l.glyphs, 'ab', 'x');
    expect(g.map((x) => x.box)).toEqual([[0, 0, 20, 10], [20, 0, 40, 10]]);
    const g2 = remapGlyphs(l.glyphs, 'abcdefgh', 'x');
    expect(g2.length).toBe(8);
    expect(g2[0].box).toEqual([0, 0, 10, 10]);
    expect(g2[7].box).toEqual([30, 0, 40, 10]);
    expect(g2.map((x) => x.text).join('')).toBe('abcdefgh');
  });
});

describe('agent settings', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
  it('defaults are off with the OCR replace mode and Sentence field', () => {
    expect(DEFAULT_AGENT_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_AGENT_SETTINGS.ocrMode).toBe('replace');
    expect(DEFAULT_AGENT_SETTINGS.sentenceField).toBe('Sentence');
  });
  it('round-trips and sanitizes', () => {
    const st = mem();
    saveAgentSettings(st, { ...DEFAULT_AGENT_SETTINGS, enabled: true, websocketUrl: 'ws://localhost:9001', matchThreshold: 7, clipPreRollMs: -5, ocrMode: 'bogus' as never });
    const s = loadAgentSettings(st);
    expect(s.enabled).toBe(true);
    expect(s.websocketUrl).toBe('ws://localhost:9001');
    expect(s.matchThreshold).toBe(1);
    expect(s.clipPreRollMs).toBe(0);
    expect(s.ocrMode).toBe('replace');
    expect(sanitizeAgentSettings({ ...DEFAULT_AGENT_SETTINGS, websocketUrl: 'http://nope' }).websocketUrl).toBe('');
  });
});
