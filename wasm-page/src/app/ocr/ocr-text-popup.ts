/**
 * OcrTextPopup — optional plain-text presentation (Plan 2 §10).
 *
 * Shows the full paragraph with the pointed character emphasized. Positioned
 * with MeikiPop's move_to math relative to the player viewport. Follows the
 * pointer while it is on source text; holds when the pointer moves toward or
 * into the card (browser adaptation); explicit pin/copy/close. No dictionary UI.
 */
import type { TextHit } from 'meikiocr-web/meikipop';
import type { CssRect, PopupPositionMode } from './ocr-types';
import { isInPopupCorridor, positionPopup } from './ocr-popup-position';

export interface PopupOptions {
  positionMode: PopupPositionMode;
  fontScale: number;
  /** Grace period (ms) during which the card holds after the pointer leaves source text. */
  holdMs: number;
}

export interface PopupCallbacks {
  onInteractionChange(active: boolean): void;
}

export class OcrTextPopup {
  private readonly el: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly before = document.createTextNode('');
  private readonly active = document.createTextNode('');
  private readonly after = document.createTextNode('');
  private readonly status: HTMLElement;
  private readonly pinBtn: HTMLButtonElement;
  private options: PopupOptions;
  private pinned = false;
  private pinnedStale = false;
  private currentText = '';
  private lastAnchor: { x: number; y: number } | null = null;
  private holdTimer: number | null = null;
  private holding = false;
  private pointerInside = false;
  private visible = false;

  constructor(
    private readonly host: HTMLElement,
    options: PopupOptions,
    private readonly cb: PopupCallbacks,
  ) {
    this.options = options;
    this.el = document.createElement('div');
    this.el.className = 'ocr-popup';
    this.el.hidden = true;
    this.el.setAttribute('role', 'note');
    this.el.setAttribute('lang', 'ja');

    const bar = document.createElement('div');
    bar.className = 'ocr-popup-bar';
    this.status = document.createElement('span');
    this.status.className = 'ocr-popup-status';
    const copyBtn = mkBtn('Copy', 'Copy recognized text', () => void this.copy());
    this.pinBtn = mkBtn('Pin', 'Keep this text in place', () => this.togglePin());
    const closeBtn = mkBtn('×', 'Close', () => this.close());
    bar.append(this.status, copyBtn, this.pinBtn, closeBtn);

    this.textEl = document.createElement('div');
    this.textEl.className = 'ocr-popup-text';
    const b = document.createElement('span');
    b.className = 'ocr-popup-before';
    b.appendChild(this.before);
    const a = document.createElement('span');
    a.className = 'ocr-popup-active';
    a.appendChild(this.active);
    const c = document.createElement('span');
    c.className = 'ocr-popup-after';
    c.appendChild(this.after);
    this.textEl.append(b, a, c);

    this.el.append(bar, this.textEl);
    this.el.addEventListener('pointerenter', () => {
      this.pointerInside = true;
      this.cb.onInteractionChange(true);
    });
    this.el.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.cb.onInteractionChange(false);
      if (!this.pinned) this.armHold();
    });
    host.appendChild(this.el);
  }

  setOptions(o: PopupOptions): void {
    this.options = o;
    this.el.style.fontSize = `${14 * o.fontScale}px`;
  }

  /** Update from a hit at a pointer location (client coords). */
  showHit(hit: TextHit, pointer: { clientX: number; clientY: number }, bounds: CssRect, confidenceNote?: string): void {
    if (this.pinned) return; // pinned content is retained deliberately
    if (this.holding && this.pointerInside) return;
    this.holding = false;
    this.clearHold();
    const textChanged = hit.fullText !== this.currentText;
    this.currentText = hit.fullText;
    // Mutate existing text nodes; nodes stay stable while the paragraph is the same.
    this.before.data = hit.fullText.slice(0, hit.utf16Offset);
    const activeLen = Array.from(hit.suffix)[0]?.length ?? 1;
    this.active.data = hit.fullText.slice(hit.utf16Offset, hit.utf16Offset + activeLen);
    this.after.data = hit.fullText.slice(hit.utf16Offset + activeLen);
    this.status.textContent = confidenceNote ?? '';
    this.el.hidden = false;
    this.visible = true;
    if (textChanged) this.pinnedStale = false;
    this.lastAnchor = { x: pointer.clientX, y: pointer.clientY };
    this.place(pointer.clientX, pointer.clientY, bounds);
  }

  private place(x: number, y: number, bounds: CssRect): void {
    const r = this.el.getBoundingClientRect();
    const pos = positionPopup(x, y, { width: r.width || 200, height: r.height || 60 }, bounds, this.options.positionMode);
    const host = this.host.getBoundingClientRect();
    this.el.style.left = `${pos.left - host.left}px`;
    this.el.style.top = `${pos.top - host.top}px`;
  }

  /** Pointer is over no source text: hold (grace) or hide. */
  noHit(pointer: { clientX: number; clientY: number } | null): void {
    if (this.pinned || !this.visible) return;
    if (pointer && this.lastAnchor && this.inCorridor(pointer)) {
      this.holding = true;
      this.armHold();
      return;
    }
    if (!this.pointerInside) this.hide();
  }

  private inCorridor(p: { clientX: number; clientY: number }): boolean {
    const r = this.el.getBoundingClientRect();
    return isInPopupCorridor({ x: p.clientX, y: p.clientY }, this.lastAnchor!, { left: r.left, top: r.top, width: r.width, height: r.height });
  }

  private armHold(): void {
    this.clearHold();
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = null;
      this.holding = false;
      if (!this.pointerInside && !this.pinned) this.hide();
    }, this.options.holdMs);
  }

  private clearHold(): void {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  /** Source changed under a pinned card: label it rather than update it. */
  markSourceChanged(): void {
    if (this.pinned && this.visible) {
      this.pinnedStale = true;
      this.status.textContent = 'pinned (source changed)';
    } else if (!this.pinned && !this.pointerInside) {
      this.hide();
    }
  }

  togglePin(): void {
    this.pinned = !this.pinned;
    this.pinBtn.textContent = this.pinned ? 'Unpin' : 'Pin';
    this.el.classList.toggle('ocr-pinned', this.pinned);
    if (!this.pinned) {
      this.pinnedStale = false;
      this.status.textContent = '';
    } else {
      this.status.textContent = 'pinned';
    }
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.currentText);
      this.flash('copied');
    } catch {
      this.flash('copy failed');
    }
  }

  private flash(msg: string): void {
    const prev = this.status.textContent;
    this.status.textContent = msg;
    window.setTimeout(() => {
      if (this.status.textContent === msg) this.status.textContent = this.pinned ? (this.pinnedStale ? 'pinned (source changed)' : 'pinned') : prev ?? '';
    }, 900);
  }

  close(): void {
    this.pinned = false;
    this.pinBtn.textContent = 'Pin';
    this.el.classList.remove('ocr-pinned');
    this.hide();
  }

  hide(): void {
    this.clearHold();
    this.holding = false;
    this.visible = false;
    this.el.hidden = true;
    this.currentText = '';
    this.before.data = '';
    this.active.data = '';
    this.after.data = '';
    if (this.pointerInside) {
      this.pointerInside = false;
      this.cb.onInteractionChange(false);
    }
  }

  isVisible(): boolean {
    return this.visible;
  }
  isPinned(): boolean {
    return this.pinned;
  }
  contains(node: Node | null): boolean {
    return !!node && this.el.contains(node);
  }

  dispose(): void {
    this.clearHold();
    this.el.remove();
  }
}

function mkBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ocr-popup-btn';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
