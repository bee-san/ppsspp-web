/**
 * Text hook (Agent script) end-to-end test on the real emulator with the homebrew test game.
 *
 *   - loads the bundled Agent-style script (public/agent-scripts/test-game.js) from the Text
 *     hook tab; the runtime captures the emulator's shared memory, locates the PSP arena and
 *     runs the script in a Worker,
 *   - the script's setWatch on the game's `g_line` buffer emits the dialogue line (Shift-JIS →
 *     text) each time the page flips (Cross = Z), with a timestamp,
 *   - OCR integration: the OCR layer's text for the line the recognizer gets wrong (fullwidth
 *     ？ comes out as ASCII ?) is replaced by the hooked text and tagged data-ocr-source="hook",
 *   - mining integration: with a hooked line present the clip starts at the line's timestamp
 *     minus the pre-roll (not the fixed default length), and the mocked AnkiConnect receives the
 *     line in the Sentence field along with audio + picture.
 *
 * Usage: npx ng build --configuration development && node scripts/e2e-agent.mjs
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, mkdirSync, createWriteStream, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const EMU_FILES = ["PPSSPPSDL.js", "PPSSPPSDL.wasm", "PPSSPPSDL.data"];
const EMU_BASE = process.env.PPSSPP_EMU_BASE ?? "https://root-hunter.github.io/ppsspp-web/build-wasm/";
const emuDir = resolve("dist/ppsspp-web/build-wasm");
mkdirSync(emuDir, { recursive: true });
for (const f of EMU_FILES) {
  const dst = join(emuDir, f);
  if (existsSync(dst)) continue;
  console.log(`downloading ${EMU_BASE}${f} …`);
  const res = await fetch(EMU_BASE + f);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(dst));
}
const TRUTH = JSON.parse(readFileSync(resolve("test-game/truth.json"), "utf8"));
const [LINE1, LINE2] = TRUTH.dialogue;

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };
const POLL = { polling: 250 };

const root = resolve("dist/ppsspp-web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".data": "application/octet-stream", ".onnx": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain" };
const PREFIX = (process.env.E2E_PATH_PREFIX ?? "").replace(/\/$/, "");
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (PREFIX) {
    if (path !== PREFIX && !path.startsWith(PREFIX + "/")) { res.writeHead(404).end("outside prefix: " + path); return; }
    path = path.slice(PREFIX.length) || "/";
  }
  let file = join(root, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));

const ankiCalls = [];
await page.route("http://127.0.0.1:8765/**", (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  ankiCalls.push(body);
  const reply = (result) => route.fulfill({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ result, error: null }) });
  switch (body.action) {
    case "requestPermission": return reply({ permission: "granted", requireApiKey: false, version: 6 });
    case "version": return reply(6);
    case "findNotes": return reply([1700000000001, 1700000000777]);
    default: return reply(null);
  }
});

/** Hold a key for several emulator frames (a slow CI emulator misses an instant press). */
const pressHeld = async (key, ms = 500) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };

await page.goto(`http://127.0.0.1:${port}${PREFIX}/`);
await page.waitForFunction(() => !!window.PpssppReadingBridge && window.crossOriginIsolated, null, { timeout: 30_000 });
check((await page.evaluate(() => window.PpssppReadingBridge.version)) >= 3, "reading bridge v3 (guest memory API)");
check(!(await page.evaluate(() => window.PpssppReadingBridge.guestMemory.available())), "no emulator memory before the emulator is started");

// Open the Text hook tab and load the example script (enables the hook).
await page.evaluate(() => { document.body.classList.add("panel-open"); const sel = document.getElementById("panelTabSelect"); sel.value = "hook"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
await page.waitForSelector("#tabHook.active", { timeout: 5000 });
await page.click("app-agent-settings button:has-text('Load test-game example')");
await page.waitForFunction(() => /JP Text Alignment Test/.test(document.querySelector("app-agent-settings .agent-script")?.textContent ?? ""), null, { timeout: 10_000, ...POLL });
check(true, "example script loaded from agent-scripts/test-game.js (name parsed from the userscript header)");
check(/Waiting for the game/.test(await page.locator("app-agent-settings .ocr-status").innerText()), "hook waits for the game");

// Also enable mining (buffering) so the timing/sentence integration can be checked later.
await page.evaluate(() => { const sel = document.getElementById("panelTabSelect"); sel.value = "mining"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
await page.waitForSelector("#tabMining.active", { timeout: 5000 });
await page.evaluate(() => { const sel = document.getElementById("panelTabSelect"); sel.value = "hook"; sel.dispatchEvent(new Event("change", { bubbles: true })); });

await page.setInputFiles("#gameFile", resolve("test-game/EBOOT.PBP"));
await page.click("#startBtn");
await page.waitForFunction(() => window.PpssppReadingBridge.getState().phase === "running", null, { timeout: 240_000 });
check(await page.evaluate(() => window.PpssppReadingBridge.guestMemory.available()), "emulator WebAssembly.Memory (shared) captured once the emulator runs");
await page.waitForFunction(() => /Script running/.test(document.querySelector("app-agent-settings .ocr-status")?.textContent ?? ""), null, { timeout: 60_000, ...POLL });
const status = await page.locator("app-agent-settings .ocr-status").innerText();
check(/1 watch/.test(status) && /1 PC hook.*inactive/.test(status), `script running: "${status}"`);
const base = await page.evaluate(() => window.PpssppReadingBridge.guestMemory.base());
check(base > 0, `PSP memory arena located at host offset 0x${base.toString(16)} (kernel HLE stub signature)`);
// Ground truth: the game's g_line read directly through the bridge. On a slow runner the
// homebrew reaches show_page() some time after the bridge reports "running", so wait for it.
const readGLine = () => page.evaluate(() => { const b = window.PpssppReadingBridge.guestMemory.read(0x088a1860, 64); if (!b) return null; const z = b.indexOf(0); return new TextDecoder("shift_jis").decode(b.subarray(0, z < 0 ? b.length : z)); });
await page.waitForFunction(() => { const b = window.PpssppReadingBridge.guestMemory.read(0x088a1860, 64); return b && b[0] !== 0 && !(b[0] === 0x69 && b[1] === 0x6e); }, null, { timeout: 120_000, ...POLL }).catch(() => {});
const gline = await readGLine();
check(gline === LINE1, `bridge read of g_line (0x088a1860) → "${gline}"`);
const latestFeed = () => page.evaluate(() => document.querySelector("app-agent-settings .agent-lines li .agent-line-text")?.textContent ?? "");

// Press Cross until the game flips (g_line changes), then the feed must show exactly that text.
const flipAndExpectFeed = async (label) => {
  const before = await readGLine();
  let after = before;
  for (let attempt = 0; attempt < 4 && after === before; attempt++) {
    await pressHeld("z");
    await page.waitForFunction(({ prev }) => { const b = window.PpssppReadingBridge.guestMemory.read(0x088a1860, 64); if (!b) return false; const z = b.indexOf(0); return new TextDecoder("shift_jis").decode(b.subarray(0, z < 0 ? b.length : z)) !== prev; }, { prev: before }, { timeout: 8_000, ...POLL }).catch(() => {});
    after = await readGLine();
  }
  const ok = after !== before && (await page.waitForFunction((want) => (document.querySelector("app-agent-settings .agent-lines li .agent-line-text")?.textContent ?? "") === want, after, { timeout: 30_000, ...POLL }).then(() => true, () => false));
  check(ok, `${label}: game now shows "${after}" → same text arrives in the feed`);
  return after;
};
await page.click("#canvas", { position: { x: 20, y: 20 } });
const l2 = await flipAndExpectFeed("page flip");
check(l2 === LINE2, `flipped to page 2 text "${LINE2}"`);
const l1 = await flipAndExpectFeed("second flip");
check(l1 === LINE1, `back to page 1 text`);
await flipAndExpectFeed("third flip"); // page 2 for the OCR/mining part
const feedCount = await page.evaluate(() => document.querySelectorAll("app-agent-settings .agent-lines li").length);
check(feedCount >= 3, `feed holds ${feedCount} lines`);
check((await readGLine()) === LINE2 && (await latestFeed()) === LINE2, "game on page 2 and feed's latest line matches it");

// ── OCR integration: the recognizer emits ASCII "?" for fullwidth "？"; the hook corrects it. ──
await page.click("#ocrToggleBtn");
await page.waitForFunction(() => document.querySelectorAll(".ocr-text-target").length >= 10, null, { timeout: 240_000, polling: 500 });
// nudge until the layer shows page-2 text (a scan of the current frame) and the hook correction is in
let hooked = false;
for (let i = 0; i < 40 && !hooked; i++) {
  await page.mouse.move(700 + (i % 5) * 5, 500 + (i % 3) * 4);
  await page.waitForTimeout(700);
  hooked = await page.evaluate(() => { const all = Array.from(document.querySelectorAll(".ocr-text-target")).map((e) => e.textContent).join(""); return /スライム/.test(all) && document.querySelectorAll('.ocr-text-target[data-ocr-source="hook"]').length > 0; });
}
const ocrText = await page.evaluate(() => ({ all: Array.from(document.querySelectorAll(".ocr-text-target")).map((e) => e.textContent).join(""), hooked: Array.from(document.querySelectorAll('.ocr-text-target[data-ocr-source="hook"]')).map((e) => e.textContent).join(""), raw: (window.__ppssppOcrDebug?.snapshot?.lines ?? []).map((l) => l.text).join("|") }));
console.log("  OCR layer text:", ocrText.all, "| hooked spans:", ocrText.hooked, "| raw OCR:", ocrText.raw);
check(hooked && ocrText.all.includes("どうする？"), `OCR layer shows the hooked text (fullwidth ？) where the recognizer had "${ocrText.raw.includes("どうする?") ? "どうする?" : "…"}"`);

// ── Mining integration: clip starts at the line's timestamp − pre-roll; Sentence field set. ──
await page.evaluate(() => { const sel = document.getElementById("panelTabSelect"); sel.value = "mining"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
await page.waitForFunction(() => /Buffered: [3-9]|Buffered: \d\d/.test(document.querySelector(".mining-buffered")?.textContent ?? ""), null, { timeout: 120_000, ...POLL });
const beforeMine = await readGLine();
let flipAt = await page.evaluate(() => performance.now());
for (let attempt = 0; attempt < 4; attempt++) {
  await pressHeld("z"); // fresh line → its timestamp is "now"
  flipAt = await page.evaluate(() => performance.now()) - 250; // the watch fires while the key is held
  const changed = await page.waitForFunction(({ prev }) => { const b = window.PpssppReadingBridge.guestMemory.read(0x088a1860, 64); if (!b) return false; const z = b.indexOf(0); return new TextDecoder("shift_jis").decode(b.subarray(0, z < 0 ? b.length : z)) !== prev; }, { prev: beforeMine }, { timeout: 8_000, ...POLL }).then(() => true, () => false);
  if (changed) break;
}
await page.waitForFunction((want) => (document.querySelector("app-agent-settings .agent-lines li .agent-line-text")?.textContent ?? "") !== want, beforeMine, { timeout: 30_000, ...POLL }).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "§", code: "Backquote", bubbles: true, cancelable: true })));
await page.waitForSelector(".mining-picker", { timeout: 30_000 });
const hotkeyAt = await page.evaluate(() => performance.now());
const sel = parseFloat(await page.locator(".mining-times strong").innerText());
const expected = (hotkeyAt - flipAt) / 1000 + 0.6; // pre-roll 600 ms
check(Math.abs(sel - expected) < 1.2, `picker preselects the clip from the hooked line: ${sel.toFixed(1)} s (line appeared ${((hotkeyAt - flipAt) / 1000).toFixed(1)} s ago + 0.6 s pre-roll; default would be 8 s)`);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })));
await page.waitForFunction(() => !document.querySelector(".mining-picker"), null, { timeout: 120_000, ...POLL });
const upd = ankiCalls.find((c) => c.action === "updateNoteFields")?.params?.note;
const currentLine = await page.evaluate(() => document.querySelector("app-agent-settings .agent-lines li .agent-line-text")?.textContent ?? "");
check(upd && upd.fields?.Sentence === currentLine && currentLine.length > 0, `AnkiConnect note ${upd?.id}: Sentence = "${upd?.fields?.Sentence}", audio → ${upd?.audio?.[0]?.fields}, picture → ${upd?.picture?.[0]?.fields}`);
check(errs.length === 0, `no uncaught page errors${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\ntext hook E2E: all checks passed");
process.exit(failures ? 1 : 0);
