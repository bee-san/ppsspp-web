# Sentence mining (audio + animated image → Anki)

asbplayer/mpvacious/GSM-style mining for the browser shell. The game is buffered
continuously (the last *N* seconds of audio and low-fps frames); the `§` hotkey or
the header **Mine** button opens a picker with the image and a trimmable waveform;
**Add** encodes an MP3 and an animated WebP (or one screenshot) and writes both
into the most recently added Anki note through AnkiConnect. Nothing is recorded
to disk; the buffers live in memory and are dropped when the tab closes.

## Setup

1. Desktop: install the [AnkiConnect](https://ankiweb.net/shared/info/2055492159)
   add-on (code `2055492159`) and keep Anki open. Android: install
   [AnkiConnect Android](https://github.com/KamWithK/AnkiconnectAndroid) next to
   AnkiDroid and start its service; the API is the same.
2. Open the side panel → **Mining** tab → **Test connection**. Anki shows a dialog
   asking whether this site may use AnkiConnect; click **Yes**. From an `https`
   page a request to `http://127.0.0.1:8765` is allowed because loopback is a
   potentially trustworthy origin; approving the dialog allowlists the page
   origin inside Anki.
3. Match the field names to your note type (defaults: `SentenceAudio`,
   `Picture`). Set the optional tag (default `ppsspp-web`, empty = none).

## Use

1. Create the card first (e.g. with Yomitan/Hachidori from the OCR text layer).
2. Press `§` (or **Mine**). The picker shows the last 8 s (configurable) of the
   20 s buffer. Drag the handles to trim; click the waveform to move the nearest
   edge; **Space** previews the selection; **← / →** step frames in screenshot
   mode (nudge the clip end in animated mode, `Shift` = 1 s, `Alt` = start).
3. **Enter** / **Add to last card**. The newest note added today
   (`findNotes("added:1")`, highest id) receives `[sound:…]` in the audio field
   and `<img>` in the picture field via `updateNoteFields`; the tag is appended.
   A toast reports `Added to note <id> ✓`.
4. If Anki is unreachable the picker stays open with the error and a
   **Download instead** button (saves the `.mp3` and `.webp` locally). With the
   picker turned off (settings) a failure downloads automatically.

While the picker is open, keyboard input does not reach the emulator (balanced
input claim on the reading bridge). `Esc` cancels.

## Settings (Mining tab, `localStorage` key `ppsspp_mining_settings_v1`)

| Setting | Default | Range |
|---|---|---|
| Enabled | on | |
| Hotkey | `§` | recorder stores `e.key` + `e.code`; `code` wins when set |
| Buffer length | 20 s | 5–60 s |
| Default clip length | 8 s | 1 s – buffer |
| Image | animated WebP | animated / screenshot |
| Frames / s, max width, quality | 8, 480 px, 0.8 | 4–15, 240–960, 0.5–0.95 |
| MP3 bitrate | 96 kbps | 64 / 96 / 128 |
| AnkiConnect URL | `http://127.0.0.1:8765` | http(s) |
| Audio / picture field, tag | `SentenceAudio` / `Picture` / `ppsspp-web` | |
| Show picker | on | off = add the default clip immediately |

Advanced: diagnostics (`Buffered: 20.0 s @ 44100 Hz`, frame count / memory),
"Debug: also download files when adding" (`localStorage.ppsspp_mining_debug`),
"Download buffer" / "Download latest frame" for checking the encoders without Anki.

## How it works

- **Audio tap.** `PpssppReadingBridge` is now `version: 2` and adds
  `addAudioTapListener(fn)`. The runtime calls the taps synchronously from the two
  places all game PCM passes through (`makeScriptProcessorShim().pushOne()`, planar;
  `pushGameAudioSamples()`, interleaved) with a wall-clock timestamp. Listeners
  copy immediately. OCR accepts any bridge `version >= 1`.
- **Rolling buffers.** `AudioRingBuffer` (planar Float32, capacity =
  seconds × sample rate) keeps a `(wallTimeMs, cumulativeFrame)` index per chunk so
  wall-clock ranges map to sample ranges by interpolation; `FrameRingBuffer` holds
  `{wallTimeMs, blob}` stills and evicts by age. Both resize on settings change.
- **Frame capture.** `MiningFrameCapture` copies the WebGL canvas inside a
  `requestAnimationFrame` callback (registered after the emulator's own, same
  trick as OCR) onto an opaque scratch canvas scaled to *max width*, then
  `toBlob('image/webp', quality)`. All-black frames are skipped; capture pauses
  while the tab is hidden or the game is not running.
- **Encoding.** MP3 via `@breezystack/lamejs` (pinned) in a module Worker.
  Animated WebP is a pure mux: `RIFF/WEBP` → `VP8X` (animation flag) + `ANIM` +
  one `ANMF` per still, wrapping each frame's `VP8 `/`VP8L` (+`ALPH`) payload with
  the gap to the next frame as duration. No re-encode.
- **Alignment.** Audio and frames are both stamped with `performance.now()` at
  production time; the SP-shim lookahead (~70–180 ms) is within sentence-card
  tolerance.

## Files

```
wasm-page/src/app/mining/
  mining-types.ts             settings, snapshot/clip types, defaults
  mining-settings.ts          load / save / sanitize / hotkey helpers (tested)
  mining-runtime-bridge.ts    typed wrapper for bridge v2 (audio tap, key hook, claim)
  audio-ring-buffer.ts        planar Float32 ring + wall-clock index, slice/peaks (tested)
  frame-ring-buffer.ts        time-bounded still frames, slice/nearest (tested)
  mining-frame-capture.ts     continuous low-fps WebP capture (rAF ordering, blank skip)
  webp-riff.ts                RIFF/WebP chunk parser + writer helpers (tested)
  webp-animation-muxer.ts     stills → animated WebP (tested)
  mp3-pcm.ts                  Float32 → Int16, chunking, lamejs encode loop (tested)
  mp3-encoder.worker.ts       module worker entry
  mp3-encoder.ts              worker client (inline fallback)
  anki-connect.ts             invoke / requestPermission / findLatestNoteId / updateNoteMedia / addTags (tested)
  mining-picker-math.ts       trim-handle math, formatting (tested)
  mining-session.service.ts   orchestration: buffers, hotkey, picker, encode, Anki, diagnostics
  mining-picker.component.*   SubMiner-style modal (preview, waveform, handles, playback)
  mining-settings.component.* side panel "Mining" tab
```

## Manual checklist (mobile)

At 360×740 and 740×360 with touch emulation: Open / Start / Load, Fullscreen /
OCR / Mine and Panel are visible without overflow (the PPSSPP.org link moves out
of the header; it stays in the About tab); the Mining tab is reachable; the
picker is a bottom sheet (portrait) or a two-column card (landscape) with a
≥ 64 px waveform, 44 px handles and ≥ 36 px buttons; handles drag with touch.

## Deferred

Animated AVIF and Opus/OGG audio behind the same encoder interfaces; per-game
field presets; "create new note" mode with sentence text from the OCR layer.
