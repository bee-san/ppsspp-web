# ppsspp-web

Web shell and local server for the PPSSPP WebAssembly build.

This fork adds a **local OCR text layer** (MeikiPop-style pointer-following
text for Yomitan/Hachidori, no bundled dictionary). See [`docs/ocr.md`](docs/ocr.md).

It also adds **sentence mining** (asbplayer/mpvacious-style): the game is
buffered continuously; press `§` or the **Mine** button, trim the last seconds of
audio in the picker, and the MP3 plus an animated WebP (or a screenshot) are
written into your most recently added Anki card via AnkiConnect. See
[`docs/mining.md`](docs/mining.md) and the section below.

**Live:** https://bee-san.github.io/ppsspp-web/ — deployed by
`.github/workflows/pages-ocr.yml` from the `main` branch. The
emulator binaries are the upstream-published PPSSPP WASM build pinned by
SHA-256 in `wasm-page/emulator.lock.json`; OCR models are pinned by
`meikiocr-web/models.lock.json`. One click on the header **OCR** button enables
text reading (the click starts the one-time ~46 MB model download, cached in the
browser; nothing leaves the page). Like MeikiPop, the recognized text is an
invisible layer placed character-by-character over the game's own text, so you
see only the game while your dictionary extension (Yomitan etc.) looks words up
on hover. Recognition covers the full game viewport by default. The **Keys** tab
in the side panel lists every key the page reacts to (OCR activation key, mining
hotkey, picker keys, PPSSPP's default keyboard map).

The invisible text is placed on the game's own glyphs to the sub-pixel and follows
the canvas through panel toggles, window resizes, fullscreen, page scroll and
device-pixel-ratio changes. This is tested end to end in the real emulator with a
small homebrew PSP program (`wasm-page/test-game/`, Japanese text at known
positions) by `wasm-page/scripts/e2e-game-alignment.mjs`, which runs in CI.

**Text hooks.** The **Text hook** tab runs [Agent](https://github.com/0xDC00/agent)-style
scripts in the browser against the emulated PSP memory (no desktop process): the script
reads the game's dialogue string as the game writes it, so the OCR layer shows the exact
text and mined clips start where the line appeared and carry it in the `Sentence` field —
the GameSentenceMiner model. `setWatch(address → handler)` stands in for Agent's `setHook`
(the prebuilt emulator has no JIT breakpoints); an external hooker WebSocket is also
accepted. See `docs/text-hooks.md`.

This repository contains:

- `wasm-page/`: Angular app, browser UI, service worker, manifest, and icons.
- `server/`: HTTPS server with COOP/COEP headers and the browser ad hoc WebSocket relay.

The emulator source and WebAssembly build outputs live in `deps/ppsspp-wasm`,
the pinned Git submodule used for reproducible checkouts and local development.
If you temporarily want to use a separate checkout, override
`WASM_ROOT=/path/to/ppsspp-wasm`.

## Sentence mining (Anki)

1. Install the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on
   (code `2055492159`) and keep Anki open. On Android use
   [AnkiConnect Android](https://github.com/KamWithK/AnkiconnectAndroid) with AnkiDroid.
2. Open the Mining settings (right-click / long-press the header **Mine** button, or
   side panel → **Mining**) → **Test connection**. Anki asks whether
   this site may use AnkiConnect — click **Yes** (the origin is allowlisted once).
3. Set the audio / picture field names to match your note type (defaults
   `SentenceAudio` / `Picture`) and an optional tag (`ppsspp-web`).
4. Create the card (e.g. with Yomitan from the OCR text layer), then press `§`
   (rebindable) or **Mine**. Trim the clip in the picker (Space = preview),
   press **Enter**. The last 8 s of the 20 s buffer are proposed; image mode is
   animated WebP (follows the audio range) or a single screenshot with a frame
   slider. If Anki is unreachable the picker offers **Download instead**.

Everything stays in memory in the browser; the only network request is to the
AnkiConnect URL you configure (default `http://127.0.0.1:8765`).

## Checkout

Clone with submodules:

```sh
git clone --recurse-submodules https://github.com/bee-san/ppsspp-web.git
```

For an existing checkout:

```sh
git submodule update --init --recursive
```

Or use the Makefile wrapper:

```sh
make wasm-submodules
```

## Local Run

Install and build the Angular app:

```sh
make app-install
make app-build
```

Build PPSSPP from the active `WASM_ROOT` first:

```sh
make wasm-dev
```

Then serve it from this repository:

```sh
make serve
```

By default the server reads `deps/ppsspp-wasm/build-wasm/` and
`deps/ppsspp-wasm/build-wasm-release/`. Use
`WASM_ROOT=/path/to/ppsspp-wasm` if the checkout lives somewhere else.

Useful local-development shortcuts:

```sh
make wasm-status
make wasm-submodule-branch
make wasm-dev
make serve
```

To update the pinned submodule to the latest `origin/wasm`:

```sh
make wasm-submodule-update
git diff --submodule
```

To pin `ppsspp-web` to the current committed HEAD of a separate sibling
`../ppsspp-wasm` checkout, when you are using one:

```sh
make wasm-pin-local
git diff --submodule
```

Push the `ppsspp-wasm` commit before sharing the `ppsspp-web` submodule pointer,
otherwise other machines will not be able to fetch it.

## Docker

```sh
make server-docker-up
```

The Docker image builds the Angular web shell in a Node stage, then serves the
compiled static bundle from the Python server. The compose file mounts
`WASM_ROOT` read-only at `/wasm`. For the sibling local checkout:

```sh
make server-docker-up-local
```

## GitHub Pages

Build the static Angular bundle with a relative base href, ready for GitHub
Pages, from an existing `ppsspp-wasm` release build:

```sh
make wasm-release
make app-build-pages
```

Or run the complete local pipeline in one shot:

```sh
make pages
```

The target writes the publishable app to `wasm-page/dist/ppsspp-web/`, adds
`.nojekyll`, copies `$(WASM_ROOT)/build-wasm-release/` into
`wasm-page/dist/ppsspp-web/build-wasm/`, and publishes
`$(WASM_ROOT)/assets/` under `build-wasm/assets/` when present. That output
directory is the exact static artifact uploaded by the GitHub Pages workflow.
