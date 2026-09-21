import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

/**
 * Emulator end-to-end check for the OCR reading layer (plan §14D, partial):
 * runs the REAL PPSSPP WASM build in headless Chromium (SwiftShader), with the
 * emulator UI language set to Japanese so its own menu supplies Japanese text
 * (no game image needed), then verifies:
 *   - render-safe capture: a rAF drawImage copy of the WebGL canvas is non-blank
 *     with preserveDrawingBuffer:false (the plan's main capture risk),
 *   - OCR on those pixels yields Japanese paragraphs and real DOM text targets
 *     positioned over the source lines,
 *   - hovering a target activates it (cached hit-test path).
 *
 * Emulator binaries: uses dist/ppsspp-web/build-wasm/PPSSPPSDL.{js,wasm,data}; if
 * absent, downloads the upstream Pages build (root-hunter.github.io/ppsspp-web).
 * NOTE: that build may differ from the pinned deps/ppsspp-wasm submodule; a local
 * `make wasm-release` build is preferred when available.
 *
 * Usage: npx ng build --configuration development && node scripts/e2e-emulator.mjs
 */
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
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };

const root = resolve("dist/ppsspp-web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".data": "application/octet-stream" };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = join(root, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => !!window.PpssppReadingBridge && window.crossOriginIsolated, null, { timeout: 30_000 });

await page.evaluate(() => localStorage.setItem("ppsspp_ocr_debug", "1"));
// Pre-seed persisted PPSSPP config with a Japanese UI so the emulator's own menu renders Japanese text.
await page.evaluate(async () => {
  const origin = await navigator.storage.getDirectory();
  let dir = await origin.getDirectoryHandle("ppsspp-web", { create: true });
  for (const part of ["persist", "home", "web_user", ".config", "ppsspp", "PSP", "SYSTEM"]) dir = await dir.getDirectoryHandle(part, { create: true });
  const fh = await dir.getFileHandle("ppsspp.ini", { create: true });
  const w = await fh.createWritable();
  await w.write("[General]\nLanguage = ja_JP\nFirstRun = False\n[Graphics]\nShowFPSCounter = 0\n");
  await w.close();
});

const t0 = Date.now();
await page.click("#startBtn");
await page.waitForFunction(() => window.PpssppReadingBridge.getState().phase === "running", null, { timeout: 240_000 });
console.log(`emulator running after ${((Date.now() - t0) / 1000).toFixed(1)} s; state=${JSON.stringify(await page.evaluate(() => window.PpssppReadingBridge.getState()))}`);
await page.waitForTimeout(8000); // let the menu render a few frames under SwiftShader
await page.screenshot({ path: "/tmp/emu-menu.png" });
const ctxInfo = await page.evaluate(() => {
  const c = document.getElementById("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight, attrs: gl ? gl.getContextAttributes() : null };
});
console.log("canvas:", JSON.stringify(ctxInfo));

// What does a rAF-synchronised drawImage copy of the WebGL canvas contain?
{
  const cap = await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      const src = document.getElementById("canvas");
      const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonzero = 0, bright = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i] | d[i+1] | d[i+2]) nonzero++; if (d[i] > 200 && d[i+1] > 200 && d[i+2] > 200) bright++; }
      resolve({ w: c.width, h: c.height, nonzeroPct: (100 * nonzero / (d.length / 4)).toFixed(1), brightPx: bright, png: c.toDataURL("image/png") });
    });
  }));
  check(Number(cap.nonzeroPct) > 5 && cap.brightPx > 1000, `render-safe capture (preserveDrawingBuffer=false): ${cap.w}x${cap.h}, ${cap.nonzeroPct}% non-black, ${cap.brightPx} bright px`);
  writeFileSync("/tmp/emu-capture.png", Buffer.from(cap.png.split(",")[1], "base64"));
}
// Enable OCR (consent) and wait for Ready.
await page.evaluate(() => { document.body.classList.add("panel-open"); document.querySelector(".tab[data-tab=ocr]").click(); });
await page.click("#ocrToggleBtn");
await page.waitForSelector(".ocr-consent", { timeout: 10_000 });
await page.click(".ocr-consent button.primary");
await page.waitForFunction(() => /^Ready/.test((document.querySelector(".ocr-status")?.textContent ?? "").trim()), null, { timeout: 180_000 });
// Show diagnostics in the panel
await page.evaluate(() => { const cb = [...document.querySelectorAll("#tabOcr input[type=checkbox]")].find((i) => /diagnostics/i.test(i.parentElement?.textContent ?? "")); if (cb && !cb.checked) cb.click(); });

// Move the pointer over the canvas (triggers movement scans) and wait for DOM text.
const box = await page.locator("#canvas").boundingBox();
for (let i = 0; i < 6; i++) {
  await page.mouse.move(box.x + box.width * (0.15 + 0.1 * i), box.y + box.height * 0.5, { steps: 5 });
  await page.waitForTimeout(700);
}
await page.waitForTimeout(3000);
const result = await page.evaluate(() => {
  const targets = [...document.querySelectorAll(".ocr-text-target")].map((el) => ({ text: el.textContent, left: el.style.left, top: el.style.top, w: el.style.width, h: el.style.height }));
  const diag = document.querySelector(".ocr-diag")?.textContent?.replace(/\s+/g, " ").trim() ?? null;
  return { targets, diag, status: document.querySelector(".ocr-status")?.textContent.trim() };
});
console.log("status:", result.status);
{
  const dbg = await page.evaluate(() => {
    const d = window.__ppssppOcrDebug;
    if (!d) return null;
    const c = document.createElement("canvas"); c.width = d.capture.width; c.height = d.capture.height;
    const ctx = c.getContext("2d"); ctx.putImageData(new ImageData(new Uint8ClampedArray(d.capture.rgba), c.width, c.height), 0, 0);
    return { meta: d.capture.meta, lines: d.snapshot.lines.map((l) => l.text), diag: d.snapshot.diagnostics, png: c.toDataURL("image/png") };
  });
  if (dbg) {
    writeFileSync("/tmp/emu-fork-capture.png", Buffer.from(dbg.png.split(",")[1], "base64"));
    console.log("fork capture meta:", JSON.stringify(dbg.meta));
    console.log("fork snapshot lines:", JSON.stringify(dbg.lines), "diag:", JSON.stringify(dbg.diag));
  } else console.log("no debug snapshot recorded");
}
console.log("diagnostics:", result.diag);
const jp = result.targets.filter((t) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(t.text));
check(jp.length >= 3, `real DOM text targets with Japanese: ${jp.length} of ${result.targets.length}`);
check(/paragraphs=[1-9]/.test(result.diag ?? "") && /blank=0/.test(result.diag ?? ""), "diagnostics: paragraphs>0, blank captures=0");
console.log(`DOM text targets (${result.targets.length}):`);
for (const t of result.targets.slice(0, 30)) console.log(`  "${t.text}" @ (${t.left}, ${t.top}) ${t.w}×${t.h}`);
// Hover the first target and check the popup/active glyph highlight follows
if (result.targets.length) {
  const el = page.locator(".ocr-text-target").first();
  const b = await el.boundingBox();
  await page.mouse.move(b.x + Math.min(8, b.width / 2), b.y + b.height / 2);
  await page.waitForTimeout(200);
  const hit = await page.evaluate(() => ({ active: document.querySelector(".ocr-active-target")?.textContent ?? null, highlightVisible: !document.querySelector(".ocr-active-glyph")?.hidden }));
  check(!!hit.active && hit.highlightVisible, `hover activates target: ${JSON.stringify(hit)}`);
}
await page.screenshot({ path: "/tmp/emu-ocr.png" });
if (process.env.E2E_VERBOSE) console.log("relevant console:\n" + logs.filter((l) => /ocr|OCR|blank|capture|error|Error/i.test(l) && !/favicon|sw\.js|Service/i.test(l)).slice(0, 20).join("\n"));
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nemulator E2E: all checks passed");
process.exit(failures ? 1 : 0);
