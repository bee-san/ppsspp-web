# JP Text Alignment Test — homebrew PSP test game

A tiny PSP homebrew (`EBOOT.PBP`, ~650 KB) that shows two static pages of Japanese
text so the OCR overlay can be tested end to end in the real emulator against known
glyph positions. No copyrighted game content: the program is ours, the font is
Droid Sans Japanese (Apache 2.0).

* `gen_scene.py` renders the two 480×272 pages with Pillow, writes `scene.h`
  (RGB565 framebuffers), `page0.png`/`page1.png` (previews) and `truth.json` — the
  ink bounding box of every character in PSP pixels, measured from the rendered
  pixels themselves. White 6×6 squares in the four corners let a test find the PSP
  frame inside the emulator canvas from pixels alone.
* `main.c` copies the current page into VRAM every vblank; **Cross** (keyboard `Z`
  in PPSSPP's default map) flips to the next page.
* `build.sh` regenerates the scene and builds `EBOOT.PBP` with the pspdev toolchain
  in Docker (`pspdev/pspdev:latest`). The built `EBOOT.PBP` is committed so CI does
  not need Docker.

Used by `scripts/e2e-game-alignment.mjs`, which boots this EBOOT through the shell's
Open Game path, enables OCR with one click and measures, per character, where the
invisible DOM text is versus where the game drew the glyph — across panel toggles,
viewport sizes, fullscreen, a pure CSS move, page scroll, a scene change and
devicePixelRatio 2.
