// ==UserScript==
// @name         [JPTX00001] JP Text Alignment Test (ppsspp-web test game)
// @version      0.1
// @author       ppsspp-web
// @description  PPSSPP (web) — text hook for wasm-page/test-game (homebrew). Reads the current
//               dialogue line the game keeps in RAM as a Shift-JIS string.
// ==/UserScript==
//
// Agent-style script (https://github.com/0xDC00/agent, https://github.com/0xDC00/scripts).
// On desktop Agent, `setHook(pc → handler)` breaks on a JIT-compiled MIPS address and the
// handler reads the string from an argument register. The web emulator has no debugger, so
// libPPSSPP.js here offers `setWatch(address → handler)`: the runtime polls the guest
// address and calls the handler when the bytes change, with regs[0].value pointing at it —
// the same handler shape, so hook handlers that read their first argument port unchanged.
//
// Addresses come from the homebrew's symbol table (psp-nm jptext.elf): the module is loaded
// at its link address 0x08804000 and `g_line` is a 160-byte volatile buffer in .data.
const { setWatch, setHook } = require('./libPPSSPP.js');

const G_LINE = 0x088a1860; // volatile unsigned char g_line[160] — current dialogue, Shift-JIS, NUL-terminated

// Join fragments arriving within 200 ms (the game writes the line in one go, so this is a no-op
// here, but real games often print name and dialogue separately).
const mainHandler = trans.send(handler, '200++');

setWatch({ [G_LINE]: mainHandler }, { size: 160, intervalMs: 50 });

// A PC hook as it would appear in a desktop script: registered but inactive on the web.
setHook({ 0x08804400: function () { return null; } });

function handler(regs) {
  /** @type NativePointer */
  const address = regs[0].value; // the watched buffer
  const s = address.readShiftJisString();
  if (!s || s === 'init') return null; // the game's placeholder before the first page is shown
  return s;
}

trans.replace(function (s) {
  // Normalize to one line: the homebrew stores both dialogue rows back to back.
  return s.replace(/\r?\n/g, '').trim();
});

console.log('test-game text hook loaded: watching g_line at 0x' + G_LINE.toString(16));
