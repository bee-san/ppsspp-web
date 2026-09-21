/**
 * Shared types for the OCR reading layer.
 *
 * Behavioural specification: MeikiPop @ ed1b70c40f38a6bd397e277ed4106c26d34dab97
 * (config.py, input.py, screenmanager.py, ocr.py, hit_scan.py, popup.py).
 * OCR engine + layout helpers: meikiocr-web (Plan 1). Nothing here implements
 * OCR, paragraph grouping or a dictionary.
 */
import type { LayoutSnapshot, TextHit } from 'meikiocr-web/meikipop';
import type { OcrProfile, OcrSnapshot, RgbaFrame } from 'meikiocr-web';

export type { LayoutSnapshot, TextHit, OcrProfile, OcrSnapshot, RgbaFrame };

/** Normalized rectangle in game-viewport coordinates (0..1). */
export interface NormRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_REGION: Readonly<NormRegion> = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/** Source-pixel rectangle (integers). */
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type Presentation = 'source-aligned' | 'popup';
export type PopupPositionMode = 'visual_novel_mode' | 'flip_horizontally' | 'flip_vertically' | 'flip_both';
export type TextLayerStrategy = 'line-text' | 'glyph-spans';
export type OcrBackendSetting = 'wasm' | 'webgpu';

/**
 * User settings. The first five mirror MeikiPop's `Config._SCHEMA['Settings']`
 * defaults exactly; the rest are player choices (Plan 2 §4).
 */
export interface OcrSettings {
  schemaVersion: 1;
  /** Overall feature toggle; separate from model download consent. */
  enabled: boolean;
  /** User accepted the local model download disclosure. */
  modelDownloadConsent: boolean;

  // --- MeikiPop-mirrored behaviour ---
  autoScan: boolean; // auto_scan_mode = True
  lookupsWithoutHotkey: boolean; // auto_scan_mode_lookups_without_hotkey = True
  scanOnMouseMove: boolean; // auto_scan_on_mouse_move = True
  scanIntervalMs: number; // auto_scan_interval_seconds = 0.5
  hotkey: string; // 'shift'

  // --- player choices ---
  presentation: Presentation;
  textLayerStrategy: TextLayerStrategy;
  popupPositionMode: PopupPositionMode;
  ocrProfile: OcrProfile;
  ocrBackend: OcrBackendSetting;
  wasmThreads: number;
  pauseGameDuringLookup: boolean;
  /**
   * Browser adaptation (plan §7 "stationary pointer and stale text"): while spatial
   * text is visible, compare the raw crop at the scan cadence. When pixels changed:
   *  - remove: retire the spatial hit targets (safest; text vanishes on animated regions)
   *  - mark:   keep the targets readable but flag them as possibly outdated (default;
   *            the next pointer movement re-scans as usual)
   *  - off:    no freshness check
   */
  stalePolicy: 'remove' | 'mark' | 'off';
  /** Cap on capture pixels; larger crops are downsampled with the transform retained. */
  maxCapturePixels: number;
  showDiagnostics: boolean;
  fontScale: number;
}

export const DEFAULT_OCR_SETTINGS: Readonly<OcrSettings> = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  modelDownloadConsent: false,
  autoScan: true,
  lookupsWithoutHotkey: true,
  scanOnMouseMove: true,
  scanIntervalMs: 500,
  hotkey: 'shift',
  presentation: 'source-aligned',
  textLayerStrategy: 'line-text',
  popupPositionMode: 'visual_novel_mode',
  ocrProfile: 'meikipop-v2',
  ocrBackend: 'wasm',
  wasmThreads: 1,
  pauseGameDuringLookup: false,
  stalePolicy: 'mark',
  maxCapturePixels: 1_048_576, // 1 MP; PSP renders are 480x272 natively
  showDiagnostics: false,
  fontScale: 1,
});

/** Per-game persisted preferences keyed by a stable game identity. */
export interface GamePrefs {
  region: NormRegion | null;
  presentation?: Presentation;
}

export type RuntimePhase = 'idle' | 'loading' | 'running' | 'aborted';

export interface BridgeState {
  phase: RuntimePhase;
  /** Increments each time the emulator runtime starts. */
  gameSessionId: number;
  /** Increments on hard content invalidations (game load, state load). */
  sceneEpoch: number;
  /** Best-effort game identity (disc ID or file name); null when unknown. */
  gameId: string | null;
  fullscreen: boolean;
  documentVisible: boolean;
}

export interface BridgeViewport {
  /** Backing-store size of the game canvas (source pixels). */
  sourceWidth: number;
  sourceHeight: number;
  /** CSS rectangle of the displayed game content (excluding letterboxing). */
  contentRect: CssRect;
  /** Increments when the canvas size or content rectangle changes. */
  geometryVersion: number;
}

export type LifecycleEvent =
  | { type: 'phase'; phase: RuntimePhase }
  | { type: 'game-changed'; gameId: string | null }
  | { type: 'scene-epoch'; sceneEpoch: number; reason: string }
  | { type: 'geometry'; geometryVersion: number }
  | { type: 'fullscreen'; active: boolean }
  | { type: 'visibility'; visible: boolean }
  | { type: 'context-lost' };

export interface CaptureMeta {
  gameSessionId: number;
  sceneEpoch: number;
  geometryVersion: number;
  /** Requested region in normalized viewport coordinates. */
  region: NormRegion;
  /** Actual crop in source pixels. */
  cropRect: PxRect;
  /** Downsample factor: image pixels = source pixels * scale. */
  scale: number;
  imageWidth: number;
  imageHeight: number;
  /** Source framebuffer size at capture time (a change invalidates the layout). */
  sourceWidth: number;
  sourceHeight: number;
}

export interface CapturedGameFrame {
  frame: RgbaFrame;
  meta: CaptureMeta;
}

/** Pointer sample in the game viewport's normalized coordinates, or null when outside. */
export interface PointerSample {
  clientX: number;
  clientY: number;
  norm: { x: number; y: number } | null;
}

export interface PublishedLayout {
  layout: LayoutSnapshot;
  snapshot: OcrSnapshot;
  meta: CaptureMeta;
  generation: number;
  publishedAtMs: number;
  /** Set by the stale check ('mark' policy): source pixels changed since this was recognized. */
  stale?: boolean;
}

export type HitPresentation = {
  hit: TextHit | null;
  pointer: { clientX: number; clientY: number } | null;
};

export type StopReason = 'disabled' | 'hidden' | 'game-stopped' | 'models-unavailable';
