/**
 * Hooked text × OCR: swap recognized line text for the exact text a text hook supplied,
 * keeping OCR's geometry — the GameSentenceMiner idea ("OCR for positions, hooker for
 * text") applied to the invisible reading layer, so the dictionary extension scans the
 * game's real string while boxes still come from pixels.
 *
 * Pure functions, unit-tested. A hooked line often spans several OCR lines (a two-line
 * dialogue box arrives as one string), so each OCR line looks for its best-matching
 * substring in the recent hooked lines; glyph boxes are re-mapped proportionally when the
 * character count differs.
 */
import type { OcrGlyph, OcrLine, OcrSnapshot } from 'meikiocr-web';

export interface HookMatchOptions {
  /** Similarity threshold (0–1) to accept a hooked substring as the same line. */
  threshold: number;
  /** `replace`: any accepted match wins; `supplement`: only when OCR's text differs from the match. */
  mode: 'replace' | 'supplement';
}

export interface HookMatchResult {
  snapshot: OcrSnapshot;
  /** Line ids whose text came from the hook. */
  corrected: string[];
}

/** Normalize for comparison only (never for output): NFKC, no whitespace, unify iteration/dashes. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[‐‑‒–—―ー－-]/g, 'ー')
    .replace(/[。．.]/g, '。')
    .replace(/[、，,]/g, '、');
}

/** Levenshtein distance over code points (small strings). */
export function editDistance(a: string, b: string): number {
  const A = Array.from(a), B = Array.from(b);
  if (!A.length) return B.length;
  if (!B.length) return A.length;
  let prev = new Array<number>(B.length + 1);
  let cur = new Array<number>(B.length + 1);
  for (let j = 0; j <= B.length; j++) prev[j] = j;
  for (let i = 1; i <= A.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= B.length; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[B.length];
}

export function similarity(a: string, b: string): number {
  const n = Math.max(Array.from(a).length, Array.from(b).length);
  if (n === 0) return 1;
  return 1 - editDistance(a, b) / n;
}

export interface SubstringMatch { text: string; score: number; start: number; end: number; /** trailing punctuation characters appended from the hooked text */ appended: number }

/**
 * Best substring of `hay` (by code points) resembling `needle`, trying lengths within ±25 %
 * of the needle. Returns null when nothing reaches `threshold`.
 */
export function bestSubstring(needle: string, hay: string, threshold: number): SubstringMatch | null {
  const N = Array.from(normalizeForMatch(needle));
  const H = Array.from(hay);
  const Hn = H.map((c) => normalizeForMatch(c)); // per-char normalization (1:1 except dropped whitespace → '')
  if (!N.length || !H.length) return null;
  // Build normalized hay with an index map back to original code points.
  const flat: string[] = [];
  const map: number[] = [];
  Hn.forEach((c, i) => { for (const ch of Array.from(c)) { flat.push(ch); map.push(i); } });
  const n = N.length;
  // Short lines need a stricter bar: at 0.5, 「アイテム」 would accept 「ライム」 (2 edits in 4).
  // Allow at most max(1, n/4) edits, i.e. ≥ 0.75 for short strings, whatever the user threshold.
  threshold = Math.max(threshold, 1 - Math.max(1, Math.floor(n / 4)) / n);
  const minLen = Math.max(1, Math.floor(n * 0.75)), maxLen = Math.min(flat.length, Math.ceil(n * 1.25));
  const needleStr = N.join('');
  let best: SubstringMatch | null = null;
  for (let len = minLen; len <= maxLen; len++) {
    for (let s = 0; s + len <= flat.length; s++) {
      // cheap prefilter: first or last char must match somewhere near
      if (flat[s] !== N[0] && flat[s + len - 1] !== N[n - 1] && len > 2) continue;
      const score = similarity(needleStr, flat.slice(s, s + len).join(''));
      if (score >= threshold && (!best || score > best.score || (score === best.score && Math.abs(len - n) < Math.abs(best.end - best.start - n)))) {
        const oStart = map[s], oEnd = map[s + len - 1] + 1;
        best = { text: H.slice(oStart, oEnd).join(''), score, start: oStart, end: oEnd, appended: 0 };
      }
    }
  }
  return best;
}

/** Re-map glyphs to a new text of possibly different length, spreading boxes proportionally. */
export function remapGlyphs(glyphs: readonly OcrGlyph[], newText: string, lineId: string): OcrGlyph[] {
  const chars = Array.from(newText);
  const M = glyphs.length;
  if (M === 0) return [];
  const out: OcrGlyph[] = [];
  let utf16 = 0;
  for (let i = 0; i < chars.length; i++) {
    // source glyph span for char i: [i*M/N, (i+1)*M/N)
    const a = Math.floor((i * M) / chars.length);
    const b = Math.max(a + 1, Math.ceil(((i + 1) * M) / chars.length));
    const src = glyphs.slice(a, Math.min(M, b));
    const box = unionBox(src.map((g) => g.box));
    const conf = src.reduce((s, g) => s + g.confidence, 0) / src.length;
    out.push({ id: `${lineId}:h${i}`, text: chars[i], box, confidence: conf, utf16Start: utf16, utf16End: utf16 + chars[i].length });
    utf16 += chars[i].length;
  }
  return out;
}

function unionBox(boxes: readonly (readonly [number, number, number, number])[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  return [x0, y0, x1, y1];
}

/**
 * Apply hooked lines (most recent last) to a snapshot. Only the last few hooked lines are
 * considered (the screen shows recent text). Returns the same snapshot when nothing changed.
 */
export function applyHookedText(snapshot: OcrSnapshot, hooked: readonly string[], opts: HookMatchOptions): HookMatchResult {
  const recent = hooked.slice(-6).reverse(); // newest first
  if (!recent.length || !snapshot.lines.length) return { snapshot, corrected: [] };
  const corrected: string[] = [];
  let changed = false;
  const lines: OcrLine[] = snapshot.lines.map((line) => {
    if (!line.text.trim()) return line;
    let best: SubstringMatch | null = null;
    for (const h of recent) {
      const m = bestSubstring(line.text, h, opts.threshold);
      if (m && (!best || m.score > best.score)) best = m;
      if (best && best.score >= 0.999) break;
    }
    if (!best) return line;
    // The recognizer often drops a line's trailing punctuation (。！？…); when the hooked text
    // continues with punctuation right after the match, take it along.
    best = extendTrailingPunctuation(best, recent.find((h) => h.includes(best!.text)) ?? '', line.text);
    const same = normalizeForMatch(best.text) === normalizeForMatch(line.text);
    if (best.text === line.text) return line; // identical: nothing to do
    if (opts.mode === 'supplement' && same) return line; // only cosmetic differences; keep OCR
    changed = true;
    corrected.push(line.id);
    const chars = Array.from(best.text);
    let glyphs: OcrGlyph[];
    if (chars.length === line.glyphs.length) {
      glyphs = line.glyphs.map((g, i) => ({ ...g, text: chars[i], utf16Start: chars.slice(0, i).join('').length, utf16End: chars.slice(0, i + 1).join('').length }));
    } else if (chars.length === line.glyphs.length + best.appended && best.appended > 0) {
      // only trailing punctuation was added: keep every recognized box, synthesize boxes after the last glyph
      glyphs = remapGlyphs(line.glyphs, chars.slice(0, line.glyphs.length).join(''), line.id);
      const last = line.glyphs[line.glyphs.length - 1].box;
      const vertical = line.orientation === 'vertical';
      const w = last[2] - last[0], h = last[3] - last[1];
      let u = glyphs.reduce((n, g) => n + g.text.length, 0);
      for (let k = 0; k < best.appended; k++) {
        const c = chars[line.glyphs.length + k];
        const box: [number, number, number, number] = vertical ? [last[0], last[3] + k * h, last[2], last[3] + (k + 1) * h] : [last[2] + k * w, last[1], last[2] + (k + 1) * w, last[3]];
        glyphs.push({ id: `${line.id}:p${k}`, text: c, box, confidence: 1, utf16Start: u, utf16End: u + c.length });
        u += c.length;
      }
    } else {
      glyphs = remapGlyphs(line.glyphs, best.text, line.id);
    }
    return { ...line, text: best.text, glyphs };
  });
  if (!changed) return { snapshot, corrected: [] };
  return { snapshot: { ...snapshot, lines }, corrected };
}

const TRAILING_PUNCT = /^[。．.！!？?、，,…‥」』）)]$/;

/** Append punctuation that follows the match in the hooked text when the OCR line lacks it. */
export function extendTrailingPunctuation(m: SubstringMatch, hay: string, ocrText: string): SubstringMatch {
  const H = Array.from(hay);
  const ocrLast = Array.from(ocrText).at(-1) ?? '';
  if (TRAILING_PUNCT.test(ocrLast)) return m;
  let end = m.end, appended = 0;
  while (end < H.length && TRAILING_PUNCT.test(H[end]) && appended < 2) { end++; appended++; }
  if (!appended) return m;
  return { ...m, end, text: H.slice(m.start, end).join(''), appended };
}

