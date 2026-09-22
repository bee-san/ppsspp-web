# Text hooks (Agent scripts) in the browser

OCR reads what is on screen; a *text hook* reads the game's own string from memory the
moment the game writes it. GameSentenceMiner (GSM) gets that from
[Agent](https://github.com/0xDC00/agent) or Textractor and uses it for two things OCR
cannot do well: the exact sentence (no recognition errors) and the *time* a line
appeared, which is what trims the audio clip. This page adds the same capability to
ppsspp-web without a desktop process: Agent-style scripts run in the browser against the
emulated PSP memory.

## What runs where

```
PPSSPPSDL.wasm (pthreads)  ──shared WebAssembly.Memory──▶  reading bridge v3 `guestMemory`
                                                                    │  base + SharedArrayBuffer
                                                        agent-sandbox.worker.ts (Worker)
                                                          Agent runtime: setWatch, trans, NativePointer
                                                                    │ { text, at }
                                                        AgentSessionService  ──▶ OCR layer (text correction)
                                                                              ──▶ mining (clip start, Sentence field)
                                                                              ──▶ clipboard (optional)
                                                        WebSocket hooker (optional) ──▶ same feed
```

* **Emulator memory.** The pinned emulator is a pthreads build: its linear memory is one
  shared `WebAssembly.Memory`. `public/ppsspp-runtime.js` wraps the `WebAssembly.Memory`
  constructor before the emulator loads and keeps the shared instance. PPSSPP keeps the
  whole emulated address space in one contiguous arena inside it, so guest address *A* is
  host offset `base + A` (scratchpad `0x00010000`, VRAM `0x04000000`, kernel RAM
  `0x08000000`, user RAM `0x08800000`). `base` is found by scanning for the HLE syscall
  stubs PPSSPP writes at guest `0x08000000` when a game boots (`jr $ra` / `syscall` /
  `break` word pattern), cached per game session and re-validated on game change. Verified
  against the homebrew test game: the arena sits at `0x05641000` in this build, VRAM shows
  the framebuffer and user RAM the module's data at their expected guest addresses.
  Exposed as `PpssppReadingBridge.guestMemory` (`available()`, `base()`, `buffer()`,
  `read(addr, len)`, `readU32(addr)`, `layout`). No emulator rebuild is needed.

* **Script runtime** (`src/app/agent/agent-runtime-api.ts`, pure, unit-tested; run inside
  `agent-sandbox.worker.ts` with the SharedArrayBuffer posted to it). Implements the Agent
  surface scripts use: `require('./libPPSSPP.js')`, `trans.send(handler, '400++')` (join
  fragments over a window, `+` = append), `trans.replace(fn)`, handlers receiving argument
  registers as `NativePointer`s (`regs[0].value.readShiftJisString()`, `.add()`, `.readU32()`,
  `.readPointer()`, `readByteArray` …), `readBinaryString`, `hexdump`, `console`,
  `sessionStorage`. Scripts are `// ==UserScript==` files; `@name` is shown in the UI.

* **`setHook` vs `setWatch`.** Desktop Agent breaks on a JIT-compiled MIPS address
  (`setHook({ 0x0886162c: handler })`). The prebuilt WASM emulator exports no debugger, so
  `setHook` registers the hooks and reports them *inactive*. Scripts use
  `setWatch({ address: handler }, { size, intervalMs, settlePolls, fireInitial })` on the
  game's text buffer instead: the worker polls the bytes and calls the handler when they
  change (after they stop changing), with `regs[0].value` pointing at the watched address —
  the same handler shape as a hook that reads its first argument, so porting is usually
  changing one line. This is the Textractor "read code" model; dialogue buffers are exactly
  what it fits. PC hooks would need an emulator build exporting PPSSPP's debugger API
  (`cpu.breakpoint.add` / `cpu.stepping`), tracked as future work.

* **External hookers.** The Text hook tab can also connect to a text hooker WebSocket
  (desktop Agent `ws://localhost:9001`, Textractor `ws://localhost:6677`, GSM-style JSON
  `{ "sentence", "time" }` or plain text) and feed those lines the same way — useful when
  running native PPSSPP alongside, or any tool that speaks that protocol.

## Choosing a script (the Text hook tab)

* **Library.** Scripts come from three places: bundled with the app (`agent-scripts/`), yours
  (pasted, written in the tab, or loaded from `.js` files) and the community repo
  (`github.com/0xDC00/scripts`, PSP entries listed through the GitHub API, cached a day, fetched
  from raw.githubusercontent.com which serves CORS). User/community scripts persist in
  `localStorage` (`ppsspp_agent_library_v1`); each remembers its `@name`, `@version`, author,
  description and the disc IDs found in its header/file name (`[ULJM05054] …`,
  `PSP_ULJM06302-3_…` → 06302 and 06303).
* **Auto-selection by disc ID.** The game image is parsed for `PARAM.SFO` (in the PBP header,
  or `PSP_GAME/PARAM.SFO` in an ISO9660 image — only the needed sectors are read) to get
  `DISC_ID` and `TITLE`; the tab shows "Game: ULJM05054 · Title" and, with auto-select on,
  picks the library script for that disc (the bundled test game is `JPTX00001`). Scripts that
  match the running game are grouped first in the selector.
* **setHook-only scripts.** Importing a community script that only uses `setHook` shows a
  warning, because the browser cannot fire code breakpoints. **Find text in memory…** fixes
  that: type (or take from the OCR layer) a few characters that are on screen, the tab
  searches the user RAM for them as Shift-JIS/UTF-8/UTF-16 and lists every hit with a preview
  of the string around it (string starts first); "Use as watch" writes a ready `setWatch`
  script for this game with the right decoder and a watch size covering the string. Verified
  end to end on the test game: the finder returns `0x088a1860 shift_jis string start` and the
  generated script produces the next line on a page flip.

## What the text is used for

1. **OCR layer correction** (default `replace`). After every recognition the controller's
   `postProcess` port (`hooked-text-match.ts`) finds, for each OCR line, the best-matching
   substring of the recent hooked lines (normalized edit similarity, lengths within ±25 %,
   threshold 0.5 by default) and swaps the text while keeping OCR's boxes; glyph boxes are
   re-mapped proportionally when the character count differs, and punctuation the
   recognizer dropped at the end of a line (`。！？`) is appended with a synthesized cell.
   A line arriving after the frame was recognized re-runs this on the cached raw snapshot
   (`OcrScanController.reprocess()`), no new inference. Corrected spans carry
   `data-ocr-source="hook"`. `supplement` only swaps lines whose text actually differs;
   `off` leaves the layer alone.
2. **Mining timing.** With a hooked line present, the picker's initial range starts at the
   line's timestamp minus a pre-roll (600 ms) instead of the fixed default clip length —
   the GSM way of trimming audio to the sentence. Timestamps are epoch-based across the
   worker/main-thread boundary.
3. **Sentence field.** `updateNoteFields` also sets the configured field (default
   `Sentence`) to the line, as GSM does.
4. **Clipboard mirror** (opt-in): every line is written to the clipboard while the page is
   focused — the classic texthooker → clipboard → GSM / clipboard inserter path.

## Test game hook

`test-game/main.c` keeps the current dialogue in `volatile unsigned char g_line[160]`
(Shift-JIS, NUL-terminated, at `0x088a1860` — the homebrew loads at its link address) and
`public/agent-scripts/test-game.js` is the matching script ("Load test-game example" in
the tab). `scripts/e2e-agent.mjs` (both CI workflows) boots the game, loads the script and
checks: memory captured and arena located; `guestMemory.read` of `g_line` returns the
page-1 line; each Cross press produces the new line in the feed; the OCR layer shows
`どうする？` (hooked) where the recognizer read `どうする`, tagged as hook text; the picker
preselects `time since the line + 0.6 s` instead of 8 s; the mocked AnkiConnect note gets
`Sentence` = the line plus audio and picture.

## Limits (honest)

* Memory-watch only: scripts that must break on code (text decoded on the fly, never kept in
  a buffer) need the debugger build. Most dialogue systems keep the current line in RAM.
* The arena search runs once per game boot (a few hundred ms over 512 MiB, stepping 4 KiB);
  if PPSSPP ever changes its kernel stub layout the detection needs a new signature.
* Homebrew and ISO games differ in where text lives; the example addresses are for the
  bundled test game. Scripts from the Agent repo target the same game memory layout, so
  their addresses carry over — only the `setHook` → `setWatch` adaptation is needed.
* The clipboard mirror needs a focused page (browser rule); the WebSocket input requires
  the hooker to accept a browser origin (Agent and Textractor plugins do).
