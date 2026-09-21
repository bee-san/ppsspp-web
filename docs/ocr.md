# OCR text layer (MeikiPop-style reading, no dictionary)

This fork adds a local OCR reading layer so Yomitan/Hachidori can look up text
rendered by the game. The player recognizes text and exposes it as ordinary,
selectable HTML; the installed extension supplies definitions. There is no
bundled dictionary, deconjugation, translation or Anki code.

- OCR engine + layout/hit-testing: [`meikiocr-web`](https://github.com/bee-san/meikiocr-web) (pinned by commit in `wasm-page/package.json`).
- Behaviour specification: MeikiPop `ed1b70c40f38a6bd397e277ed4106c26d34dab97`.
- Emulator: unchanged. A narrow, versioned `window.PpssppReadingBridge` (v1) in
  `wasm-page/public/ppsspp-runtime.js` exposes lifecycle state, the canvas/stage
  elements, and a balanced input claim.

## Files

```
wasm-page/src/app/ocr/
  ocr-types.ts               shared types, DEFAULT_OCR_SETTINGS (MeikiPop-mirrored defaults)
  ocr-scan-controller.ts     trigger/throttle/latest-intent/unchanged-image state machine (pure; tested)
  ocr-coordinate-map.ts      client CSS ↔ content rect ↔ source ↔ capture image (pure; tested)
  ocr-popup-position.ts      MeikiPop popup.move_to port (pure; tested)
  ocr-settings.ts            schema-versioned localStorage record + per-game regions (tested)
  ocr-runtime-bridge.ts      typed wrapper for window.PpssppReadingBridge
  ocr-frame-source.ts        rAF-synchronised canvas copy, region crop, bounded downsample
  ocr-text-layer.ts          source-aligned real-DOM text (line-text / glyph-spans strategies)
  ocr-text-popup.ts          plain-text card: MeikiPop placement, hold corridor, pin/copy/close
  ocr-input-gate.ts          balanced reading-input claims (selection, popup, settings)
  ocr-region-selector.ts     drag-to-select normalized region; Esc cancels
  ocr-diagnostics.ts         local-only counters
  ocr-session.service.ts     orchestration + meikiocr-web client (consent, progress, profile)
  ocr-settings.component.*   settings surface (side panel "OCR" tab)
  ocr.worker.ts              module-worker entry bundling meikiocr-web/worker
wasm-page/scripts/export-ocr-assets.mjs   fetch+verify models, copy matching ORT wasm/mjs → public/ocr-assets/
```

## Behaviour (from MeikiPop) and browser adaptations

| MeikiPop | Here |
|---|---|
| auto scan on; hotkey-free lookups; scan on mouse move; 0.5 s min interval; hotkey Shift | same defaults (`DEFAULT_OCR_SETTINGS`) |
| initial screenshot on entering auto mode | one initial scan when OCR ready + game running |
| movement → hit scan even without new OCR | immediate hit-test of cached layout |
| identical screenshot → skip OCR | exact byte equality of the raw crop (region/profile/model keyed) |
| latest-value queues | one active inference + one replaceable pending intent |
| OCR completion → hit scan | hit-tests the *current* pointer |
| manual mode: capture on hotkey rising edge | `keydown` without `repeat` |
| popup placement (VN mode, flips, 15 px gap) | same math, player viewport bounds |
| desktop screenshot lock | not needed: raw canvas pixels exclude the DOM overlay |
| — | generation guards (game/scene/region/model), hidden-tab suspension, bounded failure counting, optional stale-image check while text is visible, popup hover corridor + pin |

There is no 150 ms "hold still" delay.

## Capture

`OcrFrameSource` copies the WebGL canvas inside `requestAnimationFrame`, which
runs after the emulator's own rAF-driven frame in the same turn, before the
drawing buffer is presented (`preserveDrawingBuffer: false`). Only a pending
request triggers a copy. Diagnostics count blank captures. If a browser yields
blank captures, set `localStorage.ppsspp_ocr_preserve_drawing_buffer = "1"`
before starting the emulator (explicit opt-in; measured cost not yet recorded).

**Not yet verified with the real emulator in a browser** — see Status.

## Service worker

`sw.js` now prunes only `ppsspp-web-app-*` caches (plus the listed legacy
names). The OCR library's `meikiocr-web-assets-v1` cache and any other origin
caches are preserved. `/ocr-assets/` requests bypass the app cache (the library
verifies SHA-256 and caches them itself). `.mjs` is treated as immutable.

## Build

```sh
make app-ocr-assets      # or: npm --prefix wasm-page run ocr:export-assets
make app-build           # runs the export first
npm --prefix wasm-page test
```

`public/ocr-assets/` (~90 MB) is gitignored and produced at build time from the
pinned `models.lock.json` in meikiocr-web.

## Status / limitations (honest)

- Unit-tested: scheduler state machine (18 scenarios from the plan's table), coordinate transforms, popup placement, settings store. Production build passes.
- Not yet run against a real PPSSPP WASM build in a headed browser: capture correctness at the render boundary, extension (Yomitan/Hachidori) gate, fullscreen, input arbitration under SDL. These are release gates (plan §14 C/D/E), still open.
- Game identity is best-effort (mounted file name); PPSSPP's disc ID is not exposed to JS. Save-state loads inside the emulator are not observable from the shell, so the stale-image check is the fallback invalidation.
- WebGPU is selectable but unvalidated; it falls back to WASM.
