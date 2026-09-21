/**
 * OcrTextLayer — the dictionary-readable DOM layer (Plan 2 §9).
 *
 * Non-negotiables implemented here:
 *  - Real light-DOM text nodes (`textContent`), never innerHTML from OCR output.
 *  - One logical container per paragraph, children in reading order, no
 *    whitespace-only nodes or <br> inserted between visual lines.
 *  - Only text targets are interactive; the root and highlights are
 *    pointer-transparent.
 *  - Snapshot replacement is atomic; pointer movement only toggles classes.
 *
 * Two render strategies are provided so the extension gate (§14C) can pick:
 *  - `line-text`: one span per source line, text = line text, scaled to the line box.
 *  - `glyph-spans`: one span per glyph, positioned to its box, inside the paragraph.
 */
import type { LayoutGlyph, LayoutParagraph, LayoutSnapshot, TextHit } from 'meikiocr-web/meikipop';
import type { OcrLine } from 'meikiocr-web';
import type { BridgeViewport, CaptureMeta, CssRect, PublishedLayout, TextLayerStrategy } from './ocr-types';
import { imageRectToCss } from './ocr-coordinate-map';

export interface TextLayerOptions {
  strategy: TextLayerStrategy;
  fontScale: number;
  /** false (default) = transparent text over the game's own glyphs; true = painted (debug). */
  textVisible?: boolean;
}

interface Placed {
  el: HTMLElement;
  box: readonly [number, number, number, number];
  orientation: 'horizontal' | 'vertical';
}

export class OcrTextLayer {
  private readonly root: HTMLElement;
  private published: PublishedLayout | null = null;
  private placed: Placed[] = [];
  private glyphEls = new Map<string, HTMLElement>();
  private paragraphEls = new Map<string, HTMLElement>();
  private highlight: HTMLElement;
  private activeParagraph: HTMLElement | null = null;
  private activeGlyph: HTMLElement | null = null;
  private viewport: BridgeViewport | null = null;
  private hostRect: CssRect = { left: 0, top: 0, width: 0, height: 0 };
  private options: TextLayerOptions;
  private visible = true;

  constructor(
    private readonly host: HTMLElement,
    options: TextLayerOptions,
  ) {
    this.options = options;
    this.root = document.createElement('div');
    this.root.className = 'ocr-text-layer';
    this.root.setAttribute('lang', 'ja');
    this.root.dataset['ocrStrategy'] = options.strategy;
    this.root.classList.toggle('ocr-invisible-text', !options.textVisible);
    this.highlight = document.createElement('div');
    this.highlight.className = 'ocr-active-glyph';
    this.highlight.hidden = true;
    this.root.appendChild(this.highlight);
    host.appendChild(this.root);
  }

  setOptions(o: TextLayerOptions): void {
    const rebuild = o.strategy !== this.options.strategy;
    this.options = o;
    this.root.dataset['ocrStrategy'] = o.strategy;
    this.root.classList.toggle('ocr-invisible-text', !o.textVisible);
    if (rebuild && this.published) {
      // Force a rebuild: setLayout() short-circuits when it sees the same snapshot.
      const published = this.published;
      this.published = null;
      this.setLayout(published);
    } else this.reposition();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.classList.toggle('ocr-hidden', !v);
  }

  /** Geometry inputs: viewport (source/content) and the host's own CSS rect. */
  setGeometry(viewport: BridgeViewport | null, hostRect: CssRect): void {
    this.viewport = viewport;
    this.hostRect = hostRect;
    this.reposition();
  }

  /** Atomically replace the presented snapshot (null clears). */
  setLayout(published: PublishedLayout | null): void {
    // Same snapshot, only the stale flag changed: toggle a class, never rebuild
    // (the user may be selecting text or an extension popup may be open).
    if (published && this.published && published.snapshot === this.published.snapshot && published.generation === this.published.generation) {
      this.published = published;
      this.root.classList.toggle('ocr-stale', !!published.stale);
      return;
    }
    this.root.classList.toggle('ocr-stale', !!published?.stale);
    const next = document.createDocumentFragment();
    const placed: Placed[] = [];
    const glyphEls = new Map<string, HTMLElement>();
    const paragraphEls = new Map<string, HTMLElement>();
    this.published = published;

    if (published) {
      const hooked = new Set(published.hookedLineIds ?? []);
      this.root.classList.toggle('ocr-hooked', hooked.size > 0);
      const lineById = new Map<string, OcrLine>(published.snapshot.lines.map((l) => [l.id, l]));
      for (const p of published.layout.paragraphs) {
        const pEl = document.createElement('div');
        pEl.className = 'ocr-paragraph' + (p.isFurigana ? ' ocr-furigana' : '') + (p.orientation === 'vertical' ? ' ocr-vertical' : ' ocr-horizontal');
        pEl.dataset['ocrParagraph'] = p.id;
        if (this.options.strategy === 'glyph-spans') this.buildGlyphSpans(p, pEl, placed, glyphEls);
        else this.buildLineText(p, pEl, lineById, placed, glyphEls);
        // Mark text that came from a text hook rather than the recognizer (diagnostics/tests).
        if (hooked.size) for (const el of Array.from(pEl.querySelectorAll<HTMLElement>('.ocr-text-target'))) if (hooked.has(el.dataset['ocrLine'] ?? '')) el.dataset['ocrSource'] = 'hook';
        paragraphEls.set(p.id, pEl);
        next.appendChild(pEl);
      }
    }

    // Swap children atomically; keep the highlight node.
    for (const child of Array.from(this.root.children)) if (child !== this.highlight) child.remove();
    this.root.appendChild(next);
    this.placed = placed;
    this.glyphEls = glyphEls;
    this.paragraphEls = paragraphEls;
    this.activeGlyph = null;
    this.activeParagraph = null;
    this.highlight.hidden = true;
    this.reposition();
  }

  private buildLineText(
    p: LayoutParagraph,
    pEl: HTMLElement,
    lineById: Map<string, OcrLine>,
    placed: Placed[],
    glyphEls: Map<string, HTMLElement>,
  ): void {
    for (const lineId of p.lineIds) {
      const line = lineById.get(lineId);
      if (!line) continue;
      const span = document.createElement('span');
      span.className = 'ocr-line ocr-text-target';
      span.dataset['ocrLine'] = line.id;
      span.textContent = line.text; // text node, not markup
      pEl.appendChild(span);
      placed.push({ el: span, box: line.box, orientation: line.orientation });
      // glyph → containing line element, for emphasis
      for (const g of line.glyphs) glyphEls.set(g.id, span);
    }
  }

  private buildGlyphSpans(p: LayoutParagraph, pEl: HTMLElement, placed: Placed[], glyphEls: Map<string, HTMLElement>): void {
    for (const g of p.glyphs) {
      const span = document.createElement('span');
      span.className = 'ocr-glyph ocr-text-target';
      span.dataset['ocrGlyph'] = g.glyphId;
      span.dataset['ocrLine'] = g.lineId;
      span.textContent = g.text;
      pEl.appendChild(span);
      placed.push({ el: span, box: g.box, orientation: p.orientation });
      glyphEls.set(g.glyphId, span);
    }
  }

  private reposition(): void {
    const vp = this.viewport;
    if (!vp || !this.published) return;
    const meta = this.published.meta;
    if (this.options.strategy === 'glyph-spans') {
      this.repositionGlyphSpans(vp, meta);
      if (this.activeGlyph && !this.highlight.hidden) this.placeHighlight();
      return;
    }
    for (const pl of this.placed) {
      const css = imageRectToCss(pl.box, meta, vp.contentRect, vp.sourceWidth, vp.sourceHeight);
      const st = pl.el.style;
      // Placed with transform, NOT position:absolute. Yomitan's DOMTextScanner treats every
      // absolutely positioned element as a paragraph break (2 newlines), which would split a
      // word across a visual line wrap and defeat multi-character lookups. Inline-block
      // siblings inside one paragraph container scan as continuous text (verified against
      // the pinned scanner in scripts/e2e-emulator.mjs), matching MeikiPop's whole-paragraph
      // lookup string.
      st.transform = `translate(${css.left - this.hostRect.left}px, ${css.top - this.hostRect.top}px)`;
      st.width = `${css.width}px`;
      st.height = `${css.height}px`;
      // Zero flow advance: every sibling lays out at the paragraph origin, so the
      // transform above is the absolute placement.
      st.marginRight = `${-css.width}px`;
      const thickness = pl.orientation === 'vertical' ? css.width : css.height;
      st.fontSize = `${Math.max(6, thickness * 0.86 * this.options.fontScale)}px`;
      st.lineHeight = pl.orientation === 'vertical' ? 'normal' : `${css.height}px`;
      st.letterSpacing = '0';
    }
    // Second pass (line-text strategy): fit each line's natural advance to its source
    // extent along the reading axis with letter-spacing, so the DOM position of every
    // character tracks its OCR glyph box (extension caret hit ≈ controller hit).
    // Measuring here forces one layout per reposition (layout/resize), never per pointer event.
    if (this.options.strategy === 'line-text') {
      for (const pl of this.placed) {
        const n = pl.el.textContent?.length ?? 0;
        if (n < 2) continue;
        const vertical = pl.orientation === 'vertical';
        const natural = vertical ? pl.el.scrollHeight : pl.el.scrollWidth;
        const target = vertical ? parseFloat(pl.el.style.height) : parseFloat(pl.el.style.width); // scrollWidth ignores transforms
        if (!natural || !target) continue;
        const fontPx = parseFloat(pl.el.style.fontSize) || 1;
        // letter-spacing applies after every character (incl. the last): total = natural + n*ls
        const ls = Math.max(-0.25 * fontPx, (target - natural) / n);
        pl.el.style.letterSpacing = `${ls}px`;
      }
    }
    if (this.activeGlyph && !this.highlight.hidden) this.placeHighlight();
  }

  /**
   * glyph-spans: make each character's rendered inline box coincide with its OCR box.
   *
   * A font's glyph never fills its em box (side bearings, ascent/descent, and the
   * recognizer's boxes are ink-tight), so sizing the span to the box leaves the actual
   * text — the thing extensions hit-test with caretRangeFromPoint / getClientRects —
   * smaller and offset inside it. Instead: lay the span out at its natural size with
   * `line-height: normal` (inline box == span box), measure that once, then scale the
   * span about its top-left so the measured box maps exactly onto the OCR box. Three
   * passes = two layouts per reposition, never per pointer event.
   */
  private repositionGlyphSpans(vp: BridgeViewport, meta: CaptureMeta): void {
    const rects: CssRect[] = [];
    for (const pl of this.placed) {
      const css = imageRectToCss(pl.box, meta, vp.contentRect, vp.sourceWidth, vp.sourceHeight);
      rects.push(css);
      const st = pl.el.style;
      const thickness = pl.orientation === 'vertical' ? css.width : css.height;
      st.transform = '';
      st.width = '';
      st.height = '';
      st.marginRight = '0px';
      st.lineHeight = 'normal';
      st.letterSpacing = '0';
      st.fontSize = `${Math.max(4, thickness)}px`;
    }
    // One forced layout for all spans.
    const natural = this.placed.map((pl) => {
      const r = pl.el.getBoundingClientRect();
      return { w: r.width, h: r.height };
    });
    for (let i = 0; i < this.placed.length; i++) {
      const pl = this.placed[i];
      const css = rects[i];
      const { w, h } = natural[i];
      const sx = w > 0 ? css.width / w : 1;
      const sy = h > 0 ? css.height / h : 1;
      const st = pl.el.style;
      // Zero flow advance: every sibling lays out at the paragraph origin, so the
      // transform is the absolute placement (transform-origin is 0 0 in CSS).
      st.marginRight = `${-w}px`;
      st.transform = `translate(${css.left - this.hostRect.left}px, ${css.top - this.hostRect.top}px) scale(${sx}, ${sy})`;
    }
  }

  private activeGlyphBox: readonly [number, number, number, number] | null = null;

  private placeHighlight(): void {
    const vp = this.viewport;
    if (!vp || !this.published || !this.activeGlyphBox) return;
    const css = imageRectToCss(this.activeGlyphBox, this.published.meta, vp.contentRect, vp.sourceWidth, vp.sourceHeight);
    const st = this.highlight.style;
    st.left = `${css.left - this.hostRect.left}px`;
    st.top = `${css.top - this.hostRect.top}px`;
    st.width = `${css.width}px`;
    st.height = `${css.height}px`;
  }

  /** Emphasize the hit paragraph/glyph; only class toggles, no rebuild. */
  setHit(hit: TextHit | null): void {
    const pEl = hit ? this.paragraphEls.get(hit.paragraphId) ?? null : null;
    const gEl = hit ? this.glyphEls.get(hit.glyphId) ?? null : null;
    if (this.activeParagraph !== pEl) {
      this.activeParagraph?.classList.remove('ocr-active');
      pEl?.classList.add('ocr-active');
      this.activeParagraph = pEl;
    }
    if (this.activeGlyph !== gEl) {
      this.activeGlyph?.classList.remove('ocr-active-target');
      gEl?.classList.add('ocr-active-target');
      this.activeGlyph = gEl;
    }
    this.activeGlyphBox = hit ? hit.sourceBox : null;
    this.highlight.hidden = !hit || !this.visible;
    if (hit) this.placeHighlight();
  }

  /** Whether a DOM node belongs to this layer (for input arbitration). */
  contains(node: Node | null): boolean {
    return !!node && this.root.contains(node);
  }

  glyphFor(g: LayoutGlyph): HTMLElement | undefined {
    return this.glyphEls.get(g.glyphId);
  }

  dispose(): void {
    this.root.remove();
    this.placed = [];
    this.glyphEls.clear();
    this.paragraphEls.clear();
  }
}

/** Re-export for consumers that only need the type. */
export type { LayoutSnapshot };
