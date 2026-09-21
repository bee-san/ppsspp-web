import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { openPanelTab } from '../panel-tabs';
import { AgentSessionService } from './agent-session.service';
import type { AgentSettings } from './agent-types';

/**
 * "Text hook" tab: run an Agent-style script against the emulated PSP memory (or receive
 * lines from an external hooker over WebSocket), see the live text feed, and choose how the
 * text is used — correcting the OCR layer, captioning/timing mined clips, clipboard mirror.
 */
@Component({
  selector: 'app-agent-settings',
  templateUrl: './agent-settings.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentSettingsComponent {
  readonly agent = inject(AgentSessionService);
  readonly s = this.agent.settings;
  readonly diag = this.agent.diagnostics;
  readonly lines = this.agent.lines;
  readonly log = this.agent.log;
  readonly editing = signal(false);
  readonly draft = signal('');
  readonly loadingExample = signal(false);
  readonly recentLines = computed(() => this.lines().slice(-8).reverse());
  readonly statusClass = computed(() => {
    const p = this.diag().phase;
    return p === 'running' ? 'ok' : p === 'error' || p === 'no-memory' ? 'err' : 'idle';
  });

  set<K extends keyof AgentSettings>(key: K, value: AgentSettings[K]): void {
    this.agent.update({ [key]: value } as Partial<AgentSettings>);
  }
  onCheckbox(key: keyof AgentSettings, ev: Event): void {
    this.set(key, (ev.target as HTMLInputElement).checked as never);
  }
  onSelect(key: keyof AgentSettings, ev: Event): void {
    this.set(key, (ev.target as HTMLSelectElement).value as never);
  }
  onText(key: keyof AgentSettings, ev: Event): void {
    this.set(key, (ev.target as HTMLInputElement).value as never);
  }
  onNumber(key: keyof AgentSettings, ev: Event): void {
    this.set(key, Number((ev.target as HTMLInputElement).value) as never);
  }

  startEdit(): void {
    this.draft.set(this.s().script);
    this.editing.set(true);
  }
  saveEdit(): void {
    this.agent.update({ script: this.draft() });
    this.editing.set(false);
  }
  cancelEdit(): void {
    this.editing.set(false);
  }
  onDraft(ev: Event): void {
    this.draft.set((ev.target as HTMLTextAreaElement).value);
  }

  async loadFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;
    const text = await f.text();
    this.agent.update({ script: text });
    input.value = '';
  }

  async loadExample(): Promise<void> {
    this.loadingExample.set(true);
    try {
      const res = await fetch('agent-scripts/test-game.js', { cache: 'no-store' });
      if (res.ok) this.agent.update({ script: await res.text(), enabled: true });
    } finally {
      this.loadingExample.set(false);
    }
  }

  clearScript(): void {
    this.agent.update({ script: '', enabled: false });
  }

  testLine(): void {
    this.agent.injectLine('テスト行です。', 'script', 'manual');
  }

  openKeys(): void {
    openPanelTab('keys');
  }
  openOcr(): void {
    openPanelTab('ocr');
  }
  openMining(): void {
    openPanelTab('mining');
  }

  fmtTime(at: number): string {
    return new Date(at).toLocaleTimeString();
  }
  baseHex(): string {
    const b = this.diag().base;
    return b >= 0 ? '0x' + b.toString(16) : '—';
  }
}
