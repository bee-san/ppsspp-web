# OCR text layer (MeikiPop-style reading, no dictionary)

This fork adds a local OCR reading layer so Yomitan/Hachidori can look up text
rendered by the game. The player recognizes text and exposes it as ordinary,
selectable HTML; the installed extension supplies definitions. There is no
bundled dictionary, deconjugation, translation or Anki code.

- OCR engine + layout/hit-testing: [`meikiocr-web`](https://github.com/bee-san/meikiocr-web) (pinned by commit in `wasm-page/package.json`).
- Behaviour specification: MeikiPop `ed1b70c40f38a6bd397e277ed4106c26d34dab97`.
- Emulator: unchanged. A narrow, versioned `window.PpssppReadingBridge` (v1; v2 adds the audio tap used by [sentence mining](mining.md)) in
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
  ocr-text-layer.ts          source-aligned real-DOM text (glyph-spans default = one span per character on its OCR box; line-text alternative); invisible by default
  ocr-text-popup.ts          plain-text card: MeikiPop placement, hold corridor, pin/copy/close
  ocr-input-gate.ts          balanced reading-input claims (selection, popup, settings)
  ocr-region-selector.ts     drag-to-select normalized region; Esc cancels
  ocr-diagnostics.ts         local-only counters
  ocr-session.service.ts     orchestration + meikiocr-web client (one-click enable = download consent, progress, profile)
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
| — | generation guards (game/scene/region/model/source size), hidden-tab suspension, bounded failure counting, stale-image check while text is visible (policy `mark` default: keep text readable but flag it; `remove`; `off`), 100 ms capture back-off after an unchanged image (MeikiPop sleeps 0.1 s), popup hover corridor + pin |

There is no 150 ms "hold still" delay.

### Conformance review against MeikiPop `ed1b70c` (2026-09-21)

Re-derived from `gui/input.py`, `screenshot/screenmanager.py`, `ocr/ocr.py`,
`ocr/hit_scan.py`, `ocr/providers/meikiocr/provider.py`, `gui/popup.py`:

| MeikiPop | Fork | Match |
|---|---|---|
| Manual mode: screenshot on hotkey rising edge, no interval, no movement gate | `hotkeyDownEdge` → `requestScan('manual')` only when `!autoScan`; throttle only in auto | ✓ |
| Auto mode: one initial screenshot when auto mode starts | `maybeEnterAutoMode` | ✓ |
| Auto interval measured from the last OCR *submission*; too early → sleep remainder → re-trigger | `lastSubmitAt`, trailing throttle timer | ✓ |
| Movement mode: skip when the pointer has not moved since the last screenshot | `pointerMovedSinceLastScan` | ✓ |
| Identical screenshot → skip OCR, sleep 0.1 s, re-trigger (auto) / hit-scan (manual) | unchanged skip + 100 ms back-off + `rehit()` | ✓ |
| After every OCR (auto mode) re-set the screenshot trigger | `afterScan` services the pending intent / periodic | ✓ |
| OCR failure leaves the previous result in place | published layout untouched on failure | ✓ |
| Hit scan on every movement against the newest OCR result; runs against the *current* pointer after OCR | `rehit()` | ✓ |
| Popup shown iff lookup result AND (hotkey held OR auto ∧ lookups-without-hotkey) AND enabled | `activationAllowed()` | ✓ |
| Provider: RGB, det 0.5, rec 0.1, punct 0.2, Japanese filter, `w*1.5 < h` vertical, furigana/grouping | `meikipop-v2` profile + `meikiocr-web/meikipop` (parity-tested) | ✓ |
| Whole paragraph as lookup string (extension does the dictionary work) | full paragraph text + offset; DOM paragraph is one continuous text run for Yomitan (see below) | ✓ |
| Screenshot at raw screen resolution | capture at source resolution up to the 4 MP library guard (was 1 MP downsample; changed recognitions) | ✓ (fixed) |
| Region selection at startup | full viewport default + "Select text area" | adaptation |

**DOM representation finding.** Yomitan's `DOMTextScanner` treats every
`position:absolute` element as a paragraph break (two newlines). The previous
absolutely positioned line/glyph spans therefore split a paragraph at each
visual wrap. Spans are now `inline-block` with zero flow advance, placed by
`transform` inside one absolutely positioned paragraph container; the pinned
Yomitan scanner (vendored under `scripts/yomitan-scanner/`, test-only) reads
each paragraph as one continuous run, and caret hit-testing resolves to the
right glyph. Verified in the emulator E2E on live emulator text.

**Invisible overlay (default since settings schema v2).** The DOM text is
`color: transparent` (not `visibility: hidden`, which extensions skip): the
player sees the game's own glyphs; the extension's caret hit-testing
(`caretRangeFromPoint`) still resolves to the OCR text underneath. Each
character is its own span placed on its OCR box (`glyph-spans`), because uniform
letter-spacing over a line whose box is ink-bounded drifts by up to two
characters at the line end (harness: 13/21 caret hits for `line-text` vs 21/21
for `glyph-spans`). "Show recognized text over the game" in the OCR tab paints
the layer for debugging. v1 settings that still had the old `line-text` default
are migrated to `glyph-spans`; an explicit choice is kept.

**One-click enable.** Clicking the header OCR button is the confirmation for the
one-time model download (toast + progress line in the panel); there is no
separate consent prompt. The `modelDownloadConsent` flag is still recorded.

## Capture

`OcrFrameSource` copies the WebGL canvas inside `requestAnimationFrame`, which
runs after the emulator's own rAF-driven frame in the same turn, before the
drawing buffer is presented (`preserveDrawingBuffer: false`). Only a pending
request triggers a copy. Diagnostics count blank captures. If a browser yields
blank captures, set `localStorage.ppsspp_ocr_preserve_drawing_buffer = "1"`
before starting the emulator (explicit opt-in; measured cost not yet recorded).

Verified against the real PPSSPP WASM build in headless Chromium
(`scripts/e2e-emulator.mjs`): a rAF-synchronised `drawImage` copy of the WebGL
canvas is pixel-complete with `preserveDrawingBuffer:false` (21 % non-black,
~12 k bright pixels on the menu screen). Windowed mode only; fullscreen and
paused-game captures are still untested.

Observed on a slow CI runner (GitHub Actions + SwiftShader): 2 of 4 rAF copies
were entirely black while the scene was not, i.e. the copy landed between the
buffer being cleared and the next emulator draw. The frame source therefore
retries a blank capture once on the following frame when the previous capture
had content (`blankRetries` in diagnostics); a frame that is blank twice is
accepted as legitimately black. The opt-in `preserveDrawingBuffer` fallback
remains for hosts where that still yields blanks.

Why `stalePolicy` defaults to `mark`: PPSSPP's own menu (and many VN scenes)
has an animated background, so a strict "pixels changed → remove text" policy
erased every result 500 ms after it appeared while the pointer was still. The
default keeps the text readable and flags it; the next movement re-scans.

## Service worker

`sw.js` now prunes only `ppsspp-web-app-*` caches (plus the listed legacy
names). The OCR library's `meikiocr-web-assets-v1` cache and any other origin
caches are preserved. `/ocr-assets/` requests bypass the app cache (the library
verifies SHA-256 and caches them itself). `.mjs` is treated as immutable.

## Deployment

`pages-ocr.yml` publishes https://bee-san.github.io/ppsspp-web/ on every push to
`main`: unit tests → pinned emulator fetch (`emulator.lock.json`,
SHA-256) → OCR asset export → `ng build --base-href ./` → artifact checks →
the emulator E2E against the exact artifact mounted under `/ppsspp-web/` →
deploy. GitHub Pages sends no COOP/COEP headers; the shell's service worker
synthesises them and reloads once, exactly as upstream does.

## Build

```sh
make app-ocr-assets      # or: npm --prefix wasm-page run ocr:export-assets
make app-build           # runs the export first
npm --prefix wasm-page test
```

`public/ocr-assets/` (~90 MB) is gitignored and produced at build time from the
pinned `models.lock.json` in meikiocr-web.

## Status / limitations (honest)

- Unit-tested (41 tests): scheduler state machine (plan §14A table plus: OCR port detaching the frame buffer, disable clears text, unchanged back-off, source-size invalidation, stale policies, stale check gating), coordinate transforms, popup placement, settings store. Production build passes.
- Ground-truth harness (`scripts/e2e-fake-frame.mjs`, real app + real models, no emulator): known Japanese text drawn on the game canvas at known boxes → recognized text equals drawn text; hovering the ink centre of every character activates that character (21/21, 8/8, 5/5, 7/7 across scenes) including after a CSS resize (no re-inference); a region selection restricts recognition and mapping stays exact; unchanged pixels → no inference while moving; scene change replaces text; manual mode captures exactly once per Shift press (repeats ignored) and hides on release; popup mode stays within the stage, flips above the pointer in the lower third, hides off-text, and is the only scannable presentation. Two observations are faithful model behaviour, not bugs: line-final `。` is boxed on its ink (a cell-centre hover misses it, as in MeikiPop), and fullwidth `？` is emitted as `?`.
- Randomized fuzz (`ocr-scan-controller.fuzz.spec.ts`, 5 seeds × 600 events): ≤ 1 inference in flight; a published layout always belongs to the current generation; hits only with a published layout and allowed activation; no inference starts while ineligible; no layout while disabled/stopped; no timers after `stop()`. Mutation-checked: removing the disable-clears-layout fix fails 3/5 seeds.
- Library stress (meikiocr-web `test:browser -- --stress`): 60 identical scans with flat heap; abort storm; crash, silent worker kill (new scan watchdog) and dispose mid-scan all recover or fail cleanly.
- Debugging: `localStorage.ppsspp_ocr_debug = "1"` exposes the last capture and OCR snapshot on `window.__ppssppOcrDebug` (local only, opt-in).
- Verified in headless Chromium against the built Angular bundle (`scripts/smoke-ocr.mjs`, 2026-09-21): reading bridge v1 present; overlay + text layer mounted in `.stage`; OCR toggle → consent → model download → `Ready (wasm)` through the bundled worker chunk; keydown blocked while an input claim is held and released cleanly; settings persisted; `meikiocr-web-assets-v1` cache created; after reload the layer is ready again with **zero** `.onnx` network requests.
- The OCR engine itself is verified in Chromium in the meikiocr-web repo (24/24 fixtures match the native pipeline).
- Real emulator (headless Chromium + SwiftShader, upstream Pages build of PPSSPP 1.20.4-wasm, UI language ja_JP so the emulator's own menu supplies Japanese text; `scripts/e2e-emulator.mjs`, 2026-09-21): render-safe capture non-blank; OCR of the live canvas → 8 paragraphs / 10 real DOM text targets (ゲームの設定, PPSSPPについて, 終了 …) positioned over the source lines; hovering a target activates it. Scan latency on that host: ~1.9–2.0 s per 1365×768 frame (single WASM thread, software GL), capture 50–330 ms.
- Still open (release gates, plan §14 C/D/E): the Yomitan/Hachidori extension gate on game text (needs a headed browser with the extensions installed); emulator matrix beyond the menu screen (a real game, save/load, fullscreen, context loss, SDL input arbitration while claims are held); performance measurements on real hardware; service-worker upgrade with existing saves.
- Game identity is best-effort (mounted file name); PPSSPP's disc ID is not exposed to JS. Save-state loads inside the emulator are not observable from the shell, so the stale-image check is the fallback invalidation.
- WebGPU is selectable but unvalidated; it falls back to WASM.
