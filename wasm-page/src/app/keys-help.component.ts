import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MiningSessionService } from './mining/mining-session.service';
import { OcrSessionService } from './ocr/ocr-session.service';
import { openPanelTab } from './panel-tabs';

/**
 * Keys & shortcuts: one place that lists every key the page reacts to, reflecting the
 * current OCR activation key and mining hotkey live (so it never drifts from the settings).
 */
@Component({
  selector: 'app-keys-help',
  templateUrl: './keys-help.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeysHelpComponent {
  readonly ocr = inject(OcrSessionService);
  readonly mining = inject(MiningSessionService);

  readonly ocrKey = computed(() => {
    const k = this.ocr.settings().hotkey;
    return k === 'none' ? null : k.charAt(0).toUpperCase() + k.slice(1);
  });
  readonly ocrMode = computed(() => this.ocr.settings());
  readonly miningKey = computed(() => {
    const h = this.mining.settings().hotkey;
    return h.key && h.key !== ' ' ? h.key : h.code || 'unset';
  });

  open(tab: string): void {
    openPanelTab(tab);
  }
}
