import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { openPanelTab } from '../panel-tabs';
import { AgentSessionService } from './agent-session.service';
import type { AgentSettings } from './agent-types';
import type { CatalogEntry, LibraryScript } from './script-library';
import type { TextHit } from './text-finder';
import { OcrSessionService } from '../ocr/ocr-session.service';

/**
 * "Text hook" tab: pick a script for the running game (auto by disc ID, or from the library),
 * import community scripts (0xDC00/scripts) or paste/load your own, see the live text feed,
 * and choose how the text is used — OCR layer correction, mined-clip timing, Sentence field,
 * clipboard mirror, external hooker WebSocket.
 */
@Component({
  selector: 'app-agent-settings',
  templateUrl: './agent-settings.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentSettingsComponent {
  readonly agent = inject(AgentSessionService);
  private readonly ocr = inject(OcrSessionService);
  readonly s = this.agent.settings;
  readonly diag = this.agent.diagnostics;
  readonly lines = this.agent.lines;
  readonly log = this.agent.log;
  readonly library = this.agent.library;
  readonly selected = this.agent.selected;
  readonly game = this.agent.game;
  readonly matching = this.agent.matching;

  readonly editing = signal(false);
  readonly draft = signal('');
  readonly showLibrary = signal(false);
  readonly showImport = signal(false);
  readonly showFinder = signal(false);
  readonly finderText = signal('');
  readonly finderHits = signal<TextHit[] | null>(null);
  readonly finderBusy = signal(false);
  readonly query = signal('');
  readonly recentLines = computed(() => this.lines().slice(-8).reverse());
  readonly statusClass = computed(() => {
    const p = this.diag().phase;
    return p === 'running' ? 'ok' : p === 'error' || p === 'no-memory' ? 'err' : 'idle';
  });
  readonly results = computed(() => this.agent.searchCatalog(this.query()).slice(0, 40));
  readonly gameLabel = computed(() => {
    const g = this.game();
    if (!g.fileName && !g.discId) return 'No game running';
    return [g.discId, g.title ?? g.fileName].filter(Boolean).join(' · ');
  });
  readonly selectedAnalysis = computed(() => {
    const sc = this.selected();
    return sc ? this.agent.analyze(sc.source) : null;
  });
  /** Library grouped for the select: matching game first, then the rest by origin. */
  readonly groups = computed(() => {
    const lib = this.library();
    const match = new Set(this.matching().map((m) => m.id));
    const g = (pred: (x: LibraryScript) => boolean) => lib.filter(pred).sort((a, b) => a.name.localeCompare(b.name));
    return [
      { label: 'For this game', items: g((x) => match.has(x.id)) },
      { label: 'Your scripts', items: g((x) => !match.has(x.id) && x.origin === 'user') },
      { label: 'Imported (community)', items: g((x) => !match.has(x.id) && x.origin === 'community') },
      { label: 'Bundled', items: g((x) => !match.has(x.id) && x.origin === 'bundled') },
    ].filter((gr) => gr.items.length);
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
  onPickScript(ev: Event): void {
    const id = (ev.target as HTMLSelectElement).value;
    if (id === '__new') {
      this.startNew();
      (ev.target as HTMLSelectElement).value = this.s().selectedScriptId;
      return;
    }
    this.agent.selectScript(id, { reason: 'user' });
    if (id && !this.s().enabled) this.agent.update({ enabled: true });
  }

  // ── editing ──
  startNew(): void {
    this.draft.set(`// ==UserScript==\n// @name         [${this.game().discId ?? 'DISCID'}] ${this.game().title ?? 'Game title'}\n// @version      0.1\n// @description  PPSSPP (web) — text hook\n// ==/UserScript==\nconst { setWatch } = require('./libPPSSPP.js');\n\n// Address of the game's current dialogue string (find it with a memory search).\nconst TEXT_ADDR = 0x08800000;\n\nsetWatch({ [TEXT_ADDR]: trans.send(handler, '200++') }, { size: 256 });\n\nfunction handler(regs) {\n  return regs[0].value.readShiftJisString();\n}\n`);
    this.editing.set(true);
  }
  startEdit(): void {
    this.draft.set(this.selected()?.source ?? '');
    this.editing.set(true);
  }
  saveEdit(): void {
    const sel = this.selected();
    if (sel && sel.origin !== 'bundled') this.agent.updateScriptSource(sel.id, this.draft());
    else this.agent.addScript(this.draft(), 'user');
    if (!this.s().enabled) this.agent.update({ enabled: true });
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
    const files = Array.from(input.files ?? []);
    for (const f of files) this.agent.addScript(await f.text(), 'user', { fileName: f.name, select: files.length === 1 });
    if (files.length && !this.s().enabled) this.agent.update({ enabled: true });
    input.value = '';
  }
  removeSelected(): void {
    const sel = this.selected();
    if (sel) this.agent.removeScript(sel.id);
  }
  duplicateSelected(): void {
    const sel = this.selected();
    if (sel) this.agent.addScript(sel.source.replace(/(@name\s+)(.*)/, '$1$2 (copy)'), 'user');
  }

  // ── community import ──
  async openImport(): Promise<void> {
    this.showImport.set(true);
    await this.agent.loadCatalog();
    if (!this.query() && this.game().discId) this.query.set(this.game().discId!);
  }
  onQuery(ev: Event): void {
    this.query.set((ev.target as HTMLInputElement).value);
  }
  async importEntry(e: CatalogEntry): Promise<void> {
    const sc = await this.agent.importFromUrl(e.url, e.fileName);
    if (sc && !this.s().enabled) this.agent.update({ enabled: true });
  }
  isImported(e: CatalogEntry): boolean {
    return this.library().some((x) => x.url === e.url);
  }
  async importUrl(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const url = input.value.trim();
    if (!/^https?:\/\//.test(url)) return;
    const sc = await this.agent.importFromUrl(url);
    if (sc) input.value = '';
  }

  // ── memory text finder ──
  openFinder(): void {
    this.showFinder.set(true);
    if (!this.finderText()) this.prefillFromScreen();
  }
  /** Take the longest line the OCR layer currently shows as the search text. */
  prefillFromScreen(): void {
    const lines = Array.from(document.querySelectorAll<HTMLElement>('.ocr-text-target')).reduce<Map<string, string>>((m, el) => { const id = el.dataset['ocrLine'] ?? ''; m.set(id, (m.get(id) ?? '') + (el.textContent ?? '')); return m; }, new Map());
    const best = Array.from(lines.values()).sort((a, b) => b.length - a.length)[0] ?? '';
    if (best) this.finderText.set(best);
    else if (!this.ocr.settings().enabled) this.finderText.set('');
  }
  onFinderText(ev: Event): void {
    this.finderText.set((ev.target as HTMLInputElement).value);
  }
  async runFinder(): Promise<void> {
    const t = this.finderText().trim();
    if (Array.from(t).length < 2) return;
    this.finderBusy.set(true);
    try {
      this.finderHits.set(await this.agent.findTextInMemory(t));
    } finally {
      this.finderBusy.set(false);
    }
  }
  useHit(h: TextHit): void {
    this.agent.createWatchScript(h);
    this.showFinder.set(false);
  }
  hex(n: number): string { return '0x' + n.toString(16).padStart(8, '0'); }

  testLine(): void {
    this.agent.injectLine('テスト行です。', 'script', 'manual');
  }
  openKeys(): void { openPanelTab('keys'); }
  openOcr(): void { openPanelTab('ocr'); }
  openMining(): void { openPanelTab('mining'); }
  fmtTime(at: number): string { return new Date(at).toLocaleTimeString(); }
  baseHex(): string { const b = this.diag().base; return b >= 0 ? '0x' + b.toString(16) : '—'; }
  fmtSize(n: number): string { return n >= 1024 ? (n / 1024).toFixed(1) + ' kB' : n + ' B'; }
}
