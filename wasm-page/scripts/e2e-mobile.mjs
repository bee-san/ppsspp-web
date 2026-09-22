/**
 * Mobile layout E2E (real emulator, phone viewports):
 *   - header fits at 320/393 px wide with no clipped or overlapping controls,
 *   - every panel tab (OCR, Mining, Text hook, Keys) scrolls inside the drawer,
 *   - portrait: with the drawer open the game stays fully visible above it,
 *   - landscape phone: the emulator's automatic canvas fullscreen is redirected so the
 *     floating toolbar works, the panel opens inside fullscreen, exit works,
 *   - the mining picker fits the screen in portrait and landscape.
 *
 * Usage: npx ng build --configuration development && node scripts/e2e-mobile.mjs
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, mkdirSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { extname, join, resolve } from "node:path";
import { chromium, devices } from "playwright";

const EMU_FILES = ["PPSSPPSDL.js", "PPSSPPSDL.wasm", "PPSSPPSDL.data"];
const EMU_BASE = process.env.PPSSPP_EMU_BASE ?? "https://root-hunter.github.io/ppsspp-web/build-wasm/";
const emuDir = resolve("dist/ppsspp-web/build-wasm");
mkdirSync(emuDir, { recursive: true });
for (const f of EMU_FILES) {
  const dst = join(emuDir, f);
  if (existsSync(dst)) continue;
  const res = await fetch(EMU_BASE + f);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  await pipeline(res.body, createWriteStream(dst));
}
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };
const root = resolve("dist/ppsspp-web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".data": "application/octet-stream", ".onnx": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain" };
const PREFIX = (process.env.E2E_PATH_PREFIX ?? "").replace(/\/$/, "");
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (PREFIX) { if (path !== PREFIX && !path.startsWith(PREFIX + "/")) { res.writeHead(404).end(); return; } path = path.slice(PREFIX.length) || "/"; }
  let file = join(root, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });

const headerAudit = (page) => page.evaluate(() => {
  const items = Array.from(document.querySelectorAll("header button, header label, header select, header a")).filter((e) => e.getBoundingClientRect().width > 0);
  const name = (e) => e.id || e.className.split(" ")[0];
  const clipped = items.filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 0.5 || r.left < -0.5; }).map(name);
  const overlapping = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
    if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2 && !items[i].contains(items[j]) && !items[j].contains(items[i])) overlapping.push(name(items[i]) + "×" + name(items[j]));
  }
  return { clipped, overlapping, docOverflowX: document.documentElement.scrollWidth > innerWidth, count: items.length };
});
const boot = async (page) => {
  await page.goto(`http://127.0.0.1:${port}${PREFIX}/`);
  await page.waitForFunction(() => !!window.PpssppReadingBridge && window.crossOriginIsolated, null, { timeout: 30_000 });
  await page.setInputFiles("#gameFile", resolve("test-game/EBOOT.PBP"));
  await page.click("#startBtn");
  await page.waitForFunction(() => window.PpssppReadingBridge.getState().phase === "running", null, { timeout: 240_000 });
  await page.waitForTimeout(3000);
};
const selectTab = (page, tab) => page.evaluate((t) => { const sel = document.getElementById("panelTabSelect"); sel.value = t; sel.dispatchEvent(new Event("change", { bubbles: true })); }, tab);

// ── portrait phones ──
for (const [label, opts] of [["320x640", { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }], ["Pixel 5", { ...devices["Pixel 5"], hasTouch: true }]]) {
  const ctx = await browser.newContext(opts); const page = await ctx.newPage();
  await boot(page);
  const h = await headerAudit(page);
  check(h.clipped.length === 0 && h.overlapping.length === 0 && !h.docOverflowX && h.count >= 5, `${label}: header fits with the game running (${h.count} controls, clipped ${JSON.stringify(h.clipped)}, overlapping ${JSON.stringify(h.overlapping)})`);
  await page.click("#panelToggleBtn"); await page.waitForTimeout(600);
  const geo = await page.evaluate(() => { const c = document.getElementById("canvas").getBoundingClientRect(); const a = document.querySelector("aside").getBoundingClientRect(); return { overlap: Math.max(0, c.bottom - a.top), canvasH: c.height, asideH: a.height, vh: innerHeight }; });
  check(geo.overlap <= 1 && geo.canvasH > 150 && geo.asideH >= geo.vh * 0.4, `${label}: drawer open → game fully visible above it (canvas ${Math.round(geo.canvasH)} px, drawer ${Math.round(geo.asideH)} px, overlap ${Math.round(geo.overlap)} px)`);
  for (const tab of ["ocr", "mining", "hook", "keys"]) {
    await selectTab(page, tab); await page.waitForTimeout(350);
    const m = await page.evaluate((t) => { const host = document.getElementById("tab" + t[0].toUpperCase() + t.slice(1)).firstElementChild; const before = host.scrollTop; host.scrollTop = 1e6; return { overflowY: getComputedStyle(host).overflowY, clientH: host.clientHeight, scrollH: host.scrollHeight, scrolled: host.scrollTop - before }; }, tab);
    const needs = m.scrollH > m.clientH + 2;
    check(m.overflowY === "auto" && (!needs || m.scrolled > 0), `${label}: ${tab} tab ${needs ? `scrolls (${m.scrollH} px in ${m.clientH} px)` : "fits"}`);
  }
  await page.click("#panelToggleBtn"); await page.waitForTimeout(300);
  await page.click("#mineBtn"); await page.waitForSelector(".mining-picker", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const pk = await page.evaluate(() => { const p = document.querySelector(".mining-picker"); if (!p) return null; const r = p.getBoundingClientRect(); return { fits: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.top >= -1 && r.left >= -1, w: Math.round(r.width), h: Math.round(r.height) }; });
  check(pk?.fits, `${label}: mining picker fits the screen (${pk?.w}×${pk?.h})`);
  await ctx.close();
}

// ── landscape phone: emulator auto-fullscreen must not lock the user out ──
{
  const ctx = await browser.newContext({ ...devices["Pixel 5 landscape"], hasTouch: true }); const page = await ctx.newPage();
  await boot(page);
  const st = await page.evaluate(() => ({ fsEl: document.fullscreenElement?.className ?? null, toolbar: getComputedStyle(document.getElementById("fsToolbar")).display, atTopRight: document.elementFromPoint(innerWidth - 20, 20)?.id }));
  check(st.fsEl !== null && st.fsEl !== "" && !/canvas/i.test(st.fsEl), `landscape: emulator fullscreen redirected to the shell container (fullscreenElement ${JSON.stringify(st.fsEl)})`);
  check(st.toolbar === "flex" && st.atTopRight === "fsExitBtn", `landscape: floating toolbar visible and on top (${st.toolbar}, top-right hit: ${st.atTopRight})`);
  await page.click("#fsPanelBtn"); await page.waitForTimeout(700);
  const p = await page.evaluate(() => { const a = document.querySelector("aside").getBoundingClientRect(); const c = document.getElementById("canvas").getBoundingClientRect(); return { asideW: Math.round(a.width), asideTop: Math.round(a.top), asideH: Math.round(a.height), canvasW: Math.round(c.width), vw: innerWidth, fit: getComputedStyle(document.getElementById("canvas")).objectFit, vh: innerHeight }; });
  check(p.asideW > 200 && p.asideTop === 0 && p.asideH === p.vh && p.canvasW < p.vw && p.fit === "contain", `landscape: panel opens inside fullscreen (aside ${p.asideW}×${p.asideH} at top ${p.asideTop}; canvas ${p.canvasW} px wide, object-fit ${p.fit})`);
  await selectTab(page, "keys"); await page.waitForTimeout(300);
  const ks = await page.evaluate(() => { const host = document.querySelector("#tabKeys app-keys-help"); host.scrollTop = 1e6; return host.scrollTop > 0; });
  check(ks, "landscape: Keys tab scrolls inside the fullscreen panel");
  await page.click("#fsPanelBtn"); await page.waitForTimeout(300);
  await page.click("#fsMineBtn"); await page.waitForSelector(".mining-picker", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const pk = await page.evaluate(() => { const p = document.querySelector(".mining-picker"); if (!p) return null; const r = p.getBoundingClientRect(); return { fits: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 && r.top >= -1, w: Math.round(r.width), h: Math.round(r.height) }; });
  check(pk?.fits, `landscape: mining picker opens from the toolbar and fits (${pk?.w}×${pk?.h})`);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
  await page.waitForTimeout(400);
  await page.click("#fsExitBtn"); await page.waitForTimeout(1200);
  const out = await page.evaluate(() => ({ fs: !!document.fullscreenElement, header: document.elementFromPoint(innerWidth - 20, 20)?.id }));
  check(!out.fs && out.header === "panelToggleBtn", `landscape: exit from the toolbar restores the header (${JSON.stringify(out)})`);
  await ctx.close();
}

await browser.close(); server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nmobile layout E2E: all checks passed");
process.exit(failures ? 1 : 0);
