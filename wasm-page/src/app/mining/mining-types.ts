/**
 * Shared types for sentence mining (audio + image → Anki).
 *
 * The game is buffered continuously (PCM via the reading bridge audio tap,
 * low-fps WebP frames via canvas capture). A hotkey / the Mine button snapshots
 * the last N seconds, the picker trims them, and the result is written into the
 * most recently added Anki note through AnkiConnect.
 */

export type ImageMode = 'animated' | 'screenshot';

export interface MiningHotkey {
  /** `KeyboardEvent.key` at record time (e.g. '§'); matched when `code` is empty or differs. */
  key: string;
  /** `KeyboardEvent.code` at record time (e.g. 'Backquote'); preferred match when set. */
  code: string;
}

export interface MiningSettings {
  schemaVersion: 1;
  enabled: boolean;
  hotkey: MiningHotkey;
  /** Rolling buffer length kept for audio and frames. */
  bufferSeconds: number;
  /** Initial clip length proposed by the picker (ending "now"). */
  defaultClipSeconds: number;
  imageMode: ImageMode;
  imageFps: number;
  imageMaxWidth: number;
  imageQuality: number;
  audioBitrateKbps: number;
  ankiUrl: string;
  audioField: string;
  pictureField: string;
  /** Empty = no tag added. */
  tag: string;
  /** false = skip the picker and add the default clip immediately. */
  showPicker: boolean;
  showDiagnostics: boolean;
}

export const MINING_LIMITS = Object.freeze({
  bufferSeconds: { min: 5, max: 60 },
  defaultClipSeconds: { min: 1 },
  imageFps: { min: 4, max: 15 },
  imageMaxWidth: { min: 240, max: 960 },
  imageQuality: { min: 0.5, max: 0.95 },
  audioBitrateKbps: [64, 96, 128] as readonly number[],
});

export const DEFAULT_MINING_SETTINGS: Readonly<MiningSettings> = Object.freeze({
  schemaVersion: 1,
  enabled: true,
  hotkey: Object.freeze({ key: '§', code: '' }),
  bufferSeconds: 20,
  defaultClipSeconds: 8,
  imageMode: 'animated',
  imageFps: 8,
  imageMaxWidth: 480,
  imageQuality: 0.8,
  audioBitrateKbps: 96,
  ankiUrl: 'http://127.0.0.1:8765',
  audioField: 'SentenceAudio',
  pictureField: 'Picture',
  tag: 'ppsspp-web',
  showPicker: true,
  showDiagnostics: false,
});

/** One raw audio chunk as delivered by the runtime bridge (v2). Buffers are reused by the caller. */
export type AudioTapChunk =
  | { channels: Float32Array[]; frames: number; sampleRate: number; wallTimeMs: number }
  | { interleaved: Float32Array; channelCount: number; frames: number; sampleRate: number; wallTimeMs: number };

/** Planar PCM slice, owned by the receiver. */
export interface PcmSlice {
  channels: Float32Array[];
  sampleRate: number;
  /** Wall-clock time of the first sample. */
  startMs: number;
  /** Duration in ms derived from frame count. */
  durationMs: number;
}

/** One buffered, already-encoded still image. */
export interface BufferedFrame {
  wallTimeMs: number;
  blob: Blob;
  width: number;
  height: number;
}

/** Read-only view of a frozen audio ring (see AudioRingBuffer.clone()). */
export interface AudioSnapshot {
  slice(fromMs: number, toMs: number): PcmSlice | null;
  peaksByTime(fromMs: number, toMs: number, bins: number): Float32Array;
  readonly rate: number;
  readonly channelsCount: number;
}

/** Everything the picker needs, frozen at the moment the user pressed the hotkey. */
export interface MiningSnapshot {
  /** Wall-clock time the hotkey was pressed. */
  nowMs: number;
  /** Wall-clock bounds of the buffered audio (from the producer's timestamps). */
  audioStartMs: number;
  audioEndMs: number;
  audio: AudioSnapshot;
  frames: BufferedFrame[];
  gameId: string | null;
}

/** Result of the picker: wall-clock range within the snapshot. */
export interface MiningSelection {
  fromMs: number;
  toMs: number;
  /** Screenshot mode only: wall-clock time of the chosen frame. */
  frameAtMs?: number;
}

export interface EncodedClip {
  audio: Blob;
  image: Blob | null;
  audioFilename: string;
  imageFilename: string;
  durationMs: number;
}

export interface MiningDiagnostics {
  phase: 'bridge-missing' | 'off' | 'idle' | 'buffering' | 'picking' | 'encoding' | 'sending' | 'error';
  message: string;
  bufferedAudioMs: number;
  sampleRate: number;
  channelCount: number;
  frameCount: number;
  frameBytes: number;
  /** Wall-clock span covered by the buffered frames (ms). */
  frameSpanMs: number;
  /** Capture loop counters (see MiningFrameCapture.diag). */
  capture: { captures: number; blankRetries: number; blank: number; encodeFailures: number; lastEncodeMs: number; lastSize: string } | null;
  lastError: string | null;
  /** Result of the last Anki "Test connection". */
  anki: { ok: boolean; message: string } | null;
}

export function emptyMiningDiagnostics(): MiningDiagnostics {
  return {
    phase: 'off',
    message: 'Sentence mining is off',
    bufferedAudioMs: 0,
    sampleRate: 0,
    channelCount: 0,
    frameCount: 0,
    frameBytes: 0,
    frameSpanMs: 0,
    capture: null,
    lastError: null,
    anki: null,
  };
}
