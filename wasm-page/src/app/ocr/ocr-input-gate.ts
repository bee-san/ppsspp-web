/**
 * OcrInputGate — emulator input arbitration (Plan 2 §11).
 *
 * Holds narrowly scoped, balanced reading-input claims on the runtime bridge:
 *  - while a text selection exists inside the OCR layer or popup,
 *  - while the pointer is inside the popup card,
 *  - while the OCR settings panel has focus.
 * All release paths are balanced; focus loss and blur release everything so
 * PSP buttons cannot stick. The bridge itself never blocks keyup.
 */
import type { OcrRuntimeBridge } from './ocr-runtime-bridge';

export type ClaimReason = 'selection' | 'popup' | 'settings';

export class OcrInputGate {
  private releases = new Map<ClaimReason, () => void>();
  private selectionListener: (() => void) | null = null;
  private blurListener: (() => void) | null = null;

  constructor(
    private readonly bridge: OcrRuntimeBridge,
    private readonly isOurs: (node: Node | null) => boolean,
  ) {}

  attach(): void {
    if (this.selectionListener) return;
    this.selectionListener = () => this.syncSelection();
    document.addEventListener('selectionchange', this.selectionListener);
    this.blurListener = () => this.releaseAll();
    window.addEventListener('blur', this.blurListener);
  }

  detach(): void {
    if (this.selectionListener) document.removeEventListener('selectionchange', this.selectionListener);
    if (this.blurListener) window.removeEventListener('blur', this.blurListener);
    this.selectionListener = null;
    this.blurListener = null;
    this.releaseAll();
  }

  set(reason: ClaimReason, active: boolean): void {
    const has = this.releases.has(reason);
    if (active && !has) this.releases.set(reason, this.bridge.claimInput(`ocr:${reason}`));
    else if (!active && has) {
      this.releases.get(reason)!();
      this.releases.delete(reason);
    }
  }

  private syncSelection(): void {
    const sel = document.getSelection();
    const active = !!sel && !sel.isCollapsed && sel.rangeCount > 0 && this.isOurs(sel.anchorNode) && this.isOurs(sel.focusNode);
    this.set('selection', active);
  }

  releaseAll(): void {
    for (const r of this.releases.values()) r();
    this.releases.clear();
  }

  activeReasons(): ClaimReason[] {
    return [...this.releases.keys()];
  }
}
