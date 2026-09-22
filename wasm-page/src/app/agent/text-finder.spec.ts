import { describe, expect, it } from 'vitest';
import { encodeText, findBytes, findText, suggestWatchSize, watchScriptFor } from './text-finder';

describe('memory text finder', () => {
  it('encodes Shift-JIS via the platform decoder, UTF-8 and UTF-16LE', () => {
    expect(Array.from(encodeText('こん', 'shift_jis')!)).toEqual([0x82, 0xb1, 0x82, 0xf1]);
    expect(Array.from(encodeText('Ab', 'shift_jis')!)).toEqual([0x41, 0x62]);
    expect(Array.from(encodeText('こ', 'utf-16le')!)).toEqual([0x53, 0x30]);
    expect(Array.from(encodeText('こ', 'utf-8')!)).toEqual([0xe3, 0x81, 0x93]);
    expect(encodeText('😀', 'shift_jis')).toBeNull();
  });

  it('finds every occurrence, ranks NUL-terminated string starts first, previews the whole string', () => {
    const hay = new Uint8Array(4096);
    const line = encodeText('ここは静かな村だ。', 'shift_jis')!;
    hay.set(line, 0x100); // string start (preceded by 0)
    hay.set(encodeText('北の森', 'shift_jis')!, 0x100 + line.length + 1);
    hay.set(encodeText('XXここは静かな村だ。', 'shift_jis')!, 0x800); // mid-string
    hay.set(encodeText('ここは静かな村だ。', 'utf-16le')!, 0xc00);
    const hits = findText('ここは静か', [{ start: 0x08800000, bytes: hay }]);
    expect(hits.map((h) => [h.encoding, h.address.toString(16), h.atStringStart])).toEqual([
      ['shift_jis', '8800100', true],
      ['utf-16le', '8800c00', true],
      ['shift_jis', '8800802', false],
    ]);
    expect(hits[0].preview).toBe('ここは静かな村だ。');
    expect(hits[2].preview).toBe('XXここは静かな村だ。');
    expect(findText('こ', [{ start: 0, bytes: hay }])).toEqual([]); // too short
    expect(findBytes(new Uint8Array([1, 2, 1, 2]), new Uint8Array([1, 2]))).toEqual([0, 2]);
  });

  it('suggests a watch size covering twice the current string and generates a runnable script', () => {
    const b = new Uint8Array(300);
    b.set(encodeText('スライムが現れた。どうする？', 'shift_jis')!);
    const size = suggestWatchSize(b, 'shift_jis');
    expect(size).toBeGreaterThanOrEqual(64);
    expect(size % 16).toBe(0);
    const src = watchScriptFor(0x088a1860, 'shift_jis', size, { discId: 'JPTX00001', title: 'Test' });
    expect(src).toContain('// @name         [JPTX00001] Test');
    expect(src).toContain('const TEXT_ADDR = 0x088a1860;');
    expect(src).toContain('readShiftJisString');
    expect(watchScriptFor(1, 'utf-16le', 64, {})).toContain('readUtf16String');
  });
});
