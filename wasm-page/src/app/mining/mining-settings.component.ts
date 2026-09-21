import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';

import { describeHotkey } from './mining-settings';
import { MiningSessionService } from './mining-session.service';
import type { MiningSettings } from './mining-types';

/**
 * "Mining" tab in the side panel: enable toggle, hotkey recorder, buffer /
 * image / audio options, AnkiConnect target + "Test connection", diagnostics.
 */
@Component({
  selector: 'app-mining-settings',
  templateUrl: './mining-settings.component.html',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MiningSettingsComponent {
  readonly mining = inject(MiningSessionService);
  private readonly destroyRef = inject(DestroyRef);
  readonly s = this.mining.settings;
  readonly diag = this.mining.diagnostics;
  readonly recording = signal(false);
  readonly hotkeyLabel = computed(() => describeHotkey(this.s().hotkey));
  readonly bufferedLabel = computed(() => {
    const d = this.diag();
    if (!d.sampleRate) return 'Buffered: —';
    return `Buffered: ${(d.bufferedAudioMs / 1000).toFixed(1)} s @ ${d.sampleRate} Hz × ${d.channelCount}ch · ${d.frameCount} frames / ${(d.frameSpanMs / 1000).toFixed(1)} s (${this.fmtBytes(d.frameBytes)})`;
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.stopRecording());
  }

  set<K extends keyof MiningSettings>(key: K, value: MiningSettings[K]): void {
    this.mining.update({ [key]: value } as Partial<MiningSettings>);
  }

  onCheckbox(key: keyof MiningSettings, ev: Event): void {
    this.set(key, (ev.target as HTMLInputElement).checked as never);
  }

  onSelect(key: keyof MiningSettings, ev: Event): void {
    this.set(key, (ev.target as HTMLSelectElement).value as never);
  }

  onNumber(key: keyof MiningSettings, ev: Event): void {
    this.set(key, Number((ev.target as HTMLInputElement).value) as never);
  }

  onText(key: keyof MiningSettings, ev: Event): void {
    this.set(key, (ev.target as HTMLInputElement).value as never);
  }

  /** "Press a key": the next keydown (capture phase, before the emulator) becomes the hotkey. */
  startRecording(): void {
    if (this.recording()) {
      this.stopRecording();
      return;
    }
    this.recording.set(true);
    // Delivered through the reading bridge's key hook (see MiningSessionService.onKey): a plain
    // window listener would be cut off by the input-claim gate while this section has focus.
    this.mining.hotkeyRecorder = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') {
        this.stopRecording();
        return;
      }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // wait for a real key
      this.set('hotkey', { key: e.key, code: e.code });
      this.stopRecording();
    };
  }

  private stopRecording(): void {
    this.mining.hotkeyRecorder = null;
    this.recording.set(false);
  }

  onFocusIn(): void {
    this.mining.setSettingsFocus(true);
  }

  onFocusOut(ev: FocusEvent): void {
    const next = ev.relatedTarget as Node | null;
    const root = (ev.currentTarget as HTMLElement) ?? null;
    if (!root || !next || !root.contains(next)) this.mining.setSettingsFocus(false);
  }

  testConnection(): void {
    void this.mining.testAnkiConnection();
  }

  fmtBytes(n: number): string {
    return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;
  }
}
