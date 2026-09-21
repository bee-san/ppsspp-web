import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { OcrSessionService } from './ocr-session.service';
import type { OcrSettings } from './ocr-types';

/**
 * Small settings surface for the OCR text layer. Rendered inside the shell's
 * side panel. No dictionary UI; only capture/scheduling/presentation options.
 */
@Component({
  selector: 'app-ocr-settings',
  templateUrl: './ocr-settings.component.html',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OcrSettingsComponent {
  readonly ocr = inject(OcrSessionService);
  readonly s = this.ocr.settings;
  readonly diag = this.ocr.diagnostics;
  readonly progressPct = computed(() => {
    const p = this.diag().progress;
    return p && p.total > 0 ? Math.round((p.loaded / p.total) * 100) : null;
  });
  readonly consentRequired = computed(() => this.diag().phase === 'consent-required');

  set<K extends keyof OcrSettings>(key: K, value: OcrSettings[K]): void {
    this.ocr.update({ [key]: value } as Partial<OcrSettings>);
  }

  onCheckbox(key: keyof OcrSettings, ev: Event): void {
    this.set(key, (ev.target as HTMLInputElement).checked as never);
  }

  onSelect(key: keyof OcrSettings, ev: Event): void {
    this.set(key, (ev.target as HTMLSelectElement).value as never);
  }

  onNumber(key: keyof OcrSettings, ev: Event): void {
    this.set(key, Number((ev.target as HTMLInputElement).value) as never);
  }

  onFocusIn(): void {
    this.ocr.setSettingsFocus(true);
  }

  onFocusOut(ev: FocusEvent): void {
    const next = ev.relatedTarget as Node | null;
    const root = (ev.currentTarget as HTMLElement) ?? null;
    if (!root || !next || !root.contains(next)) this.ocr.setSettingsFocus(false);
  }

  fmtBytes(n: number): string {
    return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;
  }
}
