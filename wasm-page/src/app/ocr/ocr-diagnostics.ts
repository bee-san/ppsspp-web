/**
 * Local-only diagnostics for the OCR layer. Nothing here is transmitted.
 */
import type { ControllerDiagnostics } from './ocr-scan-controller';
import type { FrameSourceDiagnostics } from './ocr-frame-source';

export type OcrStatusPhase =
  | 'off'
  | 'consent-required'
  | 'bridge-missing'
  | 'waiting-for-game'
  | 'fetching'
  | 'verifying'
  | 'initializing'
  | 'ready'
  | 'error';

export interface OcrDiagnosticsSnapshot {
  phase: OcrStatusPhase;
  message: string;
  progress: { loaded: number; total: number } | null;
  backend: string;
  modelSetId: string;
  controller: ControllerDiagnostics | null;
  frames: FrameSourceDiagnostics | null;
  lastOcrWarnings: readonly string[];
  lastError: string | null;
  inputClaims: readonly string[];
  fullscreen: boolean;
  paragraphs: number;
}

export function emptyDiagnostics(): OcrDiagnosticsSnapshot {
  return {
    phase: 'off',
    message: 'OCR text is off',
    progress: null,
    backend: '',
    modelSetId: '',
    controller: null,
    frames: null,
    lastOcrWarnings: [],
    lastError: null,
    inputClaims: [],
    fullscreen: false,
    paragraphs: 0,
  };
}

export function describeMode(s: { autoScan: boolean; scanOnMouseMove: boolean; lookupsWithoutHotkey: boolean; hotkey: string; scanIntervalMs: number }): string {
  const key = s.hotkey === 'none' ? 'no key' : `hold ${s.hotkey}`;
  if (!s.autoScan) return `Manual: press ${s.hotkey} to capture; text active while held.`;
  const trigger = s.scanOnMouseMove ? 'on pointer movement' : `every ${s.scanIntervalMs} ms`;
  const activation = s.lookupsWithoutHotkey ? 'text follows the pointer' : `text active while you ${key}`;
  return `Auto: scans ${trigger} (min ${s.scanIntervalMs} ms apart); ${activation}.`;
}
