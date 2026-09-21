/**
 * Region selection UI: drag a rectangle over the game content; Escape cancels.
 * Stores normalized game-viewport coordinates so the selection follows the
 * game content, not browser pixels.
 */
import type { BridgeViewport, NormRegion } from './ocr-types';
import { clientToNorm, regionFromCorners } from './ocr-coordinate-map';

export class OcrRegionSelector {
  private el: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private start: { x: number; y: number } | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly viewport: () => BridgeViewport | null,
  ) {}

  /** Resolves with a region, or null when cancelled. */
  select(): Promise<NormRegion | null> {
    this.cancel();
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'ocr-region-select';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Select OCR text area. Drag to select, press Escape to cancel.');
      const hint = document.createElement('div');
      hint.className = 'ocr-region-hint';
      hint.textContent = 'Drag to select the text area · Esc to cancel';
      const box = document.createElement('div');
      box.className = 'ocr-region-box';
      box.hidden = true;
      el.append(hint, box);
      this.host.appendChild(el);
      this.el = el;
      this.box = box;

      const finish = (r: NormRegion | null) => {
        this.cancel();
        resolve(r);
      };
      const toNorm = (e: PointerEvent) => {
        const vp = this.viewport();
        return vp ? clientToNorm(e.clientX, e.clientY, vp.contentRect) : null;
      };
      el.addEventListener('pointerdown', (e) => {
        const n = toNorm(e);
        if (!n) return;
        this.start = n;
        el.setPointerCapture(e.pointerId);
        box.hidden = false;
        this.draw(n, n);
      });
      el.addEventListener('pointermove', (e) => {
        if (!this.start) return;
        const vp = this.viewport();
        if (!vp) return;
        const n = clientToNorm(e.clientX, e.clientY, vp.contentRect) ?? clampToEdge(e, vp.contentRect);
        this.draw(this.start, n);
      });
      el.addEventListener('pointerup', (e) => {
        if (!this.start) return;
        const vp = this.viewport();
        if (!vp) return finish(null);
        const n = clientToNorm(e.clientX, e.clientY, vp.contentRect) ?? clampToEdge(e, vp.contentRect);
        const r = regionFromCorners(this.start.x, this.start.y, n.x, n.y);
        this.start = null;
        finish(r.w > 0.01 && r.h > 0.01 ? r : null);
      });
      this.keyHandler = (e) => {
        if (e.key === 'Escape') {
          e.stopImmediatePropagation();
          finish(null);
        }
      };
      window.addEventListener('keydown', this.keyHandler, true);
    });
  }

  private draw(a: { x: number; y: number }, b: { x: number; y: number }): void {
    const vp = this.viewport();
    if (!vp || !this.box) return;
    const host = this.host.getBoundingClientRect();
    const r = regionFromCorners(a.x, a.y, b.x, b.y);
    const c = vp.contentRect;
    this.box.style.left = `${c.left - host.left + r.x * c.width}px`;
    this.box.style.top = `${c.top - host.top + r.y * c.height}px`;
    this.box.style.width = `${r.w * c.width}px`;
    this.box.style.height = `${r.h * c.height}px`;
  }

  cancel(): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler, true);
    this.keyHandler = null;
    this.el?.remove();
    this.el = null;
    this.box = null;
    this.start = null;
  }

  isActive(): boolean {
    return this.el !== null;
  }
}

function clampToEdge(e: PointerEvent, c: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.min(1, Math.max(0, (e.clientX - c.left) / c.width)),
    y: Math.min(1, Math.max(0, (e.clientY - c.top) / c.height)),
  };
}
