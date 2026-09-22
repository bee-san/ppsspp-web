/**
 * Text hook ("Agent script") types and settings.
 *
 * A text hook supplies the game's dialogue as *text with a timestamp* — from an Agent-style
 * script reading the emulated PSP memory in a Worker, or from an external text hooker over a
 * WebSocket (desktop Agent / Textractor, the way GameSentenceMiner consumes them). The feed
 * is used to (a) replace or supplement OCR text in the reading layer, (b) time and caption
 * mined clips, and (c) optionally mirror lines to the clipboard for GSM-style consumers.
 */
import type { StorageLike } from '../ocr/ocr-settings';

export type AgentOcrMode = 'replace' | 'supplement' | 'off';

export interface AgentSettings {
  schemaVersion: 1;
  /** Run the in-browser script when a game is running. */
  enabled: boolean;
  /** Agent userscript source (JavaScript) of the selected script (copy kept for the worker). */
  script: string;
  /** Display name (from the `@name` header when present). */
  scriptName: string;
  /** Library id of the selected script ('' = none). */
  selectedScriptId: string;
  /** Pick the library script whose disc ID matches the running game automatically. */
  autoSelect: boolean;
  /** With no working script for the game: find the dialogue buffer by correlating OCR'd lines with memory and create a watch script. */
  autoDiscover: boolean;
  /**
   * How hooked text meets OCR: `replace` — OCR line text is swapped for the matching hooked
   * line (boxes stay OCR's); `supplement` — only lines OCR got wrong (low similarity) are
   * swapped; `off` — text feed only.
   */
  ocrMode: AgentOcrMode;
  /** Minimum similarity (0–1) for a hooked line to be considered the same line as an OCR line. */
  matchThreshold: number;
  /** Also connect to an external text hooker WebSocket (empty = off), e.g. ws://localhost:9001 (Agent), ws://localhost:6677 (Textractor). */
  websocketUrl: string;
  /** Mirror every line to the clipboard (needs the page focused; the classic texthooker → GSM/clipboard-inserter path). */
  copyToClipboard: boolean;
  /** Write the latest hooked line into this Anki field when mining (empty = don't). */
  sentenceField: string;
  /** Start mined clips at the line's timestamp minus this pre-roll (ms) instead of the fixed default clip length. */
  clipFromLine: boolean;
  clipPreRollMs: number;
  showLog: boolean;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  schemaVersion: 1,
  enabled: false,
  script: '',
  scriptName: '',
  selectedScriptId: '',
  autoSelect: true,
  autoDiscover: true,
  ocrMode: 'replace',
  matchThreshold: 0.5,
  websocketUrl: '',
  copyToClipboard: false,
  sentenceField: 'Sentence',
  clipFromLine: true,
  clipPreRollMs: 600,
  showLog: false,
};

export const AGENT_SETTINGS_KEY = 'ppsspp_agent_settings_v1';

export function loadAgentSettings(storage: StorageLike): AgentSettings {
  try {
    const raw = storage.getItem(AGENT_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AgentSettings> & { schemaVersion?: number };
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) return { ...DEFAULT_AGENT_SETTINGS };
    return sanitizeAgentSettings({ ...DEFAULT_AGENT_SETTINGS, ...parsed, schemaVersion: 1 });
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

export function saveAgentSettings(storage: StorageLike, s: AgentSettings): void {
  storage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(sanitizeAgentSettings(s)));
}

export function sanitizeAgentSettings(s: AgentSettings): AgentSettings {
  const d = DEFAULT_AGENT_SETTINGS;
  const out: AgentSettings = { ...s, schemaVersion: 1 };
  for (const k of ['enabled', 'copyToClipboard', 'clipFromLine', 'showLog', 'autoSelect', 'autoDiscover'] as const) out[k] = typeof out[k] === 'boolean' ? out[k] : d[k];
  out.selectedScriptId = typeof out.selectedScriptId === 'string' ? out.selectedScriptId.slice(0, 200) : '';
  out.script = typeof out.script === 'string' ? out.script.slice(0, 512 * 1024) : '';
  out.scriptName = typeof out.scriptName === 'string' ? out.scriptName.slice(0, 120) : '';
  if (!['replace', 'supplement', 'off'].includes(out.ocrMode)) out.ocrMode = d.ocrMode;
  out.matchThreshold = Number.isFinite(out.matchThreshold) ? Math.min(1, Math.max(0, out.matchThreshold)) : d.matchThreshold;
  out.websocketUrl = typeof out.websocketUrl === 'string' && /^wss?:\/\//.test(out.websocketUrl.trim()) ? out.websocketUrl.trim() : '';
  out.sentenceField = typeof out.sentenceField === 'string' ? out.sentenceField.trim().slice(0, 64) : d.sentenceField;
  out.clipPreRollMs = Number.isFinite(out.clipPreRollMs) ? Math.round(Math.min(10_000, Math.max(0, out.clipPreRollMs))) : d.clipPreRollMs;
  return out;
}

/** One hooked line as seen by consumers (OCR layer, mining, UI). */
export interface HookedLine {
  id: number;
  text: string;
  /** performance.now() on the main thread when the line was received. */
  at: number;
  /** Wall-clock Date.now() at reception (for GSM-style `time` fields). */
  wall: number;
  source: 'script' | 'websocket';
  detail: string;
}

export type AgentPhase = 'off' | 'waiting' | 'no-memory' | 'locating' | 'running' | 'error';

export interface GameIdentity { fileName: string | null; discId: string | null; title: string | null }

export interface AgentDiagnostics {
  phase: AgentPhase;
  message: string;
  base: number;
  hooks: number;
  watches: number;
  lines: number;
  websocket: 'off' | 'connecting' | 'open' | 'closed';
  lastError: string;
}
