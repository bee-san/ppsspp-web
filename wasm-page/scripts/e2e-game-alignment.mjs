/**
 * Overlay alignment E2E on the REAL emulator with a known game.
 *
 * Boots test-game/EBOOT.PBP (a homebrew that draws two pages of Japanese text at
 * positions recorded in test-game/truth.json, with white 6×6 corner markers) in the
 * real PPSSPP WASM build, enables OCR with one click, and measures — for every
 * character — where the invisible DOM text actually is versus where the game drew
 * the glyph:
 *
 *   truth (PSP px) ──markers──▶ canvas px ──CSS box / object-fit──▶ client CSS px
 *   DOM glyph rect = Range.getBoundingClientRect() of the character's text node,
 *                    i.e. exactly what Yomitan/10ten/rikaikun hit-test against.
 *
 * The PSP→canvas mapping is read off the pixels (the corner markers in the OCR
 * capture) and the canvas→CSS mapping off computed style, so nothing here reuses
 * the app's own geometry code. Metrics per scenario: centre offset (CSS px and %
 * of glyph height), IoU with the ink box, and the share of characters for which
 * document.caretRangeFromPoint at the glyph's ink centre resolves to that very
 * character (the extension-visible outcome).
 *
 * Scenarios: panel closed/open, several viewport sizes (incl. a phone-sized one),
 * browser fullscreen, a layout shift that moves the canvas without resizing it,
 * page scroll, and devicePixelRatio 2 (second browser context).
 *
 * Usage: npx ng build --configuration development && node scripts/e2e-game-alignment.mjs
 * Env:   ALIGN_JSON=/path/out.json  writes all raw measurements;
 *        E2E_PATH_PREFIX=/ppsspp-web serves dist under a sub-path like GitHub Pages.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createWriteStream } from "node:fs";
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
const charsOf = (page) => page.flatMap((run) => run.chars.map((c) => ({ ...c, size: run.size, line: run.text })));
const CHARS = charsOf(TRUTH.pages[0]);
const CHARS2 = charsOf(TRUTH.pages[1]);

const root = resolve("dist/ppsspp-web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".data": "application/octet-stream", ".onnx": "application/octet-stream", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain" };
const PREFIX = (process.env.E2E_PATH_PREFIX ?? "").replace(/\/$/, ""); // e.g. /ppsspp-web, as served by Pages
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

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };
const results = [];

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });

// ───────────────────────── measurement (runs in the page) ─────────────────────────
// Returns per-character records for the current layout.
const MEASURE = `(chars) => {
  const dbg = window.__ppssppOcrDebug;
  if (!dbg?.capture) return { error: "no capture" };
  const cap = dbg.capture, W = cap.width, H = cap.height, px = cap.rgba instanceof ArrayBuffer ? new Uint8ClampedArray(cap.rgba) : cap.rgba;
  const bright = (x, y) => { const i = (y * W + x) * 4; return px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200; };
  // corner markers: the bright square touching each image corner (PPSSPP may letterbox the
  // 480x272 frame by a few px, so walk the diagonal inwards to the first bright pixel, then
  // extend along the edge row/column while bright). Anchored to the corner, so text near a
  // corner cannot be mistaken for a marker.
  const maxD = Math.max(8, Math.round(Math.min(W, H) * 0.06));
  const corner = (sx, sy, dx, dy) => {
    let d = 0;
    while (d < maxD && !bright(sx + dx * d, sy + dy * d)) d++;
    if (d >= maxD) return null;
    const x0 = sx + dx * d, y0 = sy + dy * d;
    let x = x0, y = y0;
    while (x + dx >= 0 && x + dx < W && bright(x + dx, y0)) x += dx;
    while (y + dy >= 0 && y + dy < H && bright(x0, y + dy)) y += dy;
    const L = Math.min(x0, x), R = Math.max(x0, x) + 1, T = Math.min(y0, y), B = Math.max(y0, y) + 1;
    const side = Math.max(R - L, B - T), expect = 6 * (W / ${TRUTH.width});
    if (side > expect * 2.5 || side < expect * 0.4) return null; // not a 6×6 PSP-px square
    return { L, T, R, B };
  };
  const tl = corner(0, 0, 1, 1), tr = corner(W - 1, 0, -1, 1), bl = corner(0, H - 1, 1, -1), br = corner(W - 1, H - 1, -1, -1);
  if (!tl || !tr || !bl || !br) return { error: "markers not found", tl, tr, bl, br };
  // PSP frame in capture px (outer edges of the markers), then in source (canvas backing) px
  const frame = { L: Math.min(tl.L, bl.L), T: Math.min(tl.T, tr.T), R: Math.max(tr.R, br.R), B: Math.max(bl.B, br.B) };
  const m = cap.meta;
  const src = { L: m.cropRect.x + frame.L / m.scale, T: m.cropRect.y + frame.T / m.scale, R: m.cropRect.x + frame.R / m.scale, B: m.cropRect.y + frame.B / m.scale };
  const PSPW = ${TRUTH.width}, PSPH = ${TRUTH.height};
  const sxPer = (src.R - src.L) / PSPW, syPer = (src.B - src.T) / PSPH;
  // canvas → CSS, from computed style only
  const c = document.getElementById("canvas");
  const r = c.getBoundingClientRect();
  const box = { left: r.left + c.clientLeft, top: r.top + c.clientTop, width: r.width - (c.offsetWidth - c.clientWidth), height: r.height - (c.offsetHeight - c.clientHeight) };
  const fit = getComputedStyle(c).objectFit;
  let content = { ...box };
  if (fit === "contain") {
    const ba = box.width / box.height, sa = c.width / c.height;
    if (ba > sa) { const w = box.height * sa; content = { left: box.left + (box.width - w) / 2, top: box.top, width: w, height: box.height }; }
    else if (ba < sa) { const h = box.width / sa; content = { left: box.left, top: box.top + (box.height - h) / 2, width: box.width, height: h }; }
  }
  const cssPerSrcX = content.width / c.width, cssPerSrcY = content.height / c.height;
  const toCss = (pxX, pxY) => ({ x: content.left + (src.L + pxX * sxPer) * cssPerSrcX, y: content.top + (src.T + pxY * syPer) * cssPerSrcY });
  const targets = Array.from(document.querySelectorAll(".ocr-text-target"));
  const nfkc = (s) => s.normalize("NFKC");
  const glyphRect = (el) => { const tn = el.firstChild; if (!tn || tn.nodeType !== 3) return el.getBoundingClientRect(); const rg = document.createRange(); rg.selectNodeContents(tn); const rr = rg.getBoundingClientRect(); return rr.width > 0 ? rr : el.getBoundingClientRect(); };
  const layer = document.querySelector(".ocr-text-layer");
  const caretAt = (x, y) => {
    // occluded by UI (header, panel, toasts…)? then the point is not the game's problem
    const top = document.elementFromPoint(x, y);
    if (!top) return { occluded: true };
    if (!layer?.contains(top) && top.id !== "canvas" && !top.closest?.(".stage")) return { occluded: true, by: top.tagName + "." + top.className };
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return { ch: null };
    const n = range.startContainer;
    const el = n.nodeType === 3 ? n.parentElement : n;
    const t = n.nodeType === 3 ? n.textContent : (n.firstChild?.nodeType === 3 ? n.firstChild.textContent : null);
    if (t == null || !el?.closest(".ocr-text-target")) return { ch: null };
    const arr = Array.from(t); const off = Math.min(range.startOffset, Math.max(0, arr.length - 1));
    return { ch: arr[off] ?? null };
  };
  const out = [];
  for (const ch of chars) {
    const a = toCss(ch.x0, ch.y0), b = toCss(ch.x1, ch.y1);
    const truth = { left: a.x, top: a.y, right: b.x, bottom: b.y, w: b.x - a.x, h: b.y - a.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    const em = ch.size * syPer * cssPerSrcY; // the run's font size in CSS px
    // caret hit-tests: ink centre + the four inner quarter points
    const pts = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([fx, fy]) => [truth.left + fx * truth.w, truth.top + fy * truth.h]);
    const hits = pts.map(([x, y]) => caretAt(x, y));
    const centre = hits[0];
    const caretOk = !centre.occluded && centre.ch != null && nfkc(centre.ch) === nfkc(ch.ch);
    const ptsTested = hits.filter((h) => !h.occluded).length;
    const ptsOk = hits.filter((h) => !h.occluded && h.ch != null && nfkc(h.ch) === nfkc(ch.ch)).length;
    // nearest DOM glyph with the same character
    let best = null, bestEl = null, bestD = 1e9;
    for (const el of targets) {
      const txt = Array.from(el.textContent ?? "");
      if (txt.length !== 1 || nfkc(txt[0]) !== nfkc(ch.ch)) continue;
      const g = glyphRect(el);
      const d = Math.hypot((g.left + g.right) / 2 - truth.cx, (g.top + g.bottom) / 2 - truth.cy);
      if (d < bestD) { bestD = d; best = g; bestEl = el; }
    }
    let dom = null, box = null, dx = null, dy = null, iou = null, cover = null, glyphVsBox = null;
    if (best) {
      dom = { left: best.left, top: best.top, right: best.right, bottom: best.bottom, w: best.width, h: best.height };
      const br = bestEl.getBoundingClientRect();
      box = { left: br.left, top: br.top, right: br.right, bottom: br.bottom, w: br.width, h: br.height };
      glyphVsBox = Math.max(Math.abs(br.left - best.left), Math.abs(br.top - best.top), Math.abs(br.right - best.right), Math.abs(br.bottom - best.bottom));
      dx = (best.left + best.right) / 2 - truth.cx; dy = (best.top + best.bottom) / 2 - truth.cy;
      const ix = Math.max(0, Math.min(best.right, truth.right) - Math.max(best.left, truth.left));
      const iy = Math.max(0, Math.min(best.bottom, truth.bottom) - Math.max(best.top, truth.top));
      const inter = ix * iy; iou = inter / (best.width * best.height + truth.w * truth.h - inter);
      cover = inter / (truth.w * truth.h);
    }
    out.push({ ch: ch.ch, size: ch.size, em, truth, dom, box, glyphVsBox, dx, dy, iou, cover, caretOk, occluded: !!centre.occluded, occludedBy: centre.by, caretChar: centre.ch, ptsTested, ptsOk, found: !!best });
  }
  return { frame, src, content, fit, canvas: { w: c.width, h: c.height, css: box }, dpr: devicePixelRatio, glyphCount: targets.length, out };
}`;

function summarize(label, m) {
  if (m.error) { check(false, `${label}: ${m.error} ${JSON.stringify(m).slice(0, 200)}`); return null; }
  const rs = m.out;
  const found = rs.filter((r) => r.found);
  const visible = rs.filter((r) => !r.occluded);
  const caret = visible.filter((r) => r.caretOk).length;
  const ptsTested = rs.reduce((a, r) => a + r.ptsTested, 0), ptsOk = rs.reduce((a, r) => a + r.ptsOk, 0);
  const relErr = found.map((r) => Math.hypot(r.dx, r.dy) / r.em);
  const pxErr = found.map((r) => Math.hypot(r.dx, r.dy));
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  const max = (a) => (a.length ? Math.max(...a) : NaN);
  const cover = found.map((r) => r.cover);
  const gvb = max(found.map((r) => r.glyphVsBox));
  const s = { label, dpr: m.dpr, fit: m.fit, canvas: `${m.canvas.w}x${m.canvas.h}@${m.canvas.css.width.toFixed(1)}x${m.canvas.css.height.toFixed(1)}`, glyphs: m.glyphCount, chars: rs.length, found: found.length, visible: visible.length, caretOk: caret, ptsTested, ptsOk, meanRel: mean(relErr), maxRel: max(relErr), meanPx: mean(pxErr), maxPx: max(pxErr), meanCover: mean(cover), minCover: Math.min(...cover), meanIou: mean(found.map((r) => r.iou)), glyphVsBoxMax: gvb };
  results.push({ ...s, raw: m });
  const worst = [...found].sort((a, b) => Math.hypot(b.dx, b.dy) / b.em - Math.hypot(a.dx, a.dy) / a.em).slice(0, 3).map((r) => `${r.ch}(${(100 * Math.hypot(r.dx, r.dy) / r.em).toFixed(0)}%,${r.dx.toFixed(1)},${r.dy.toFixed(1)})`).join(" ");
  const missedCaret = visible.filter((r) => !r.caretOk).map((r) => `${r.ch}→${r.caretChar ?? "∅"}`).slice(0, 8).join(" ");
  const occl = rs.filter((r) => r.occluded).length;
  console.log(`  ${label}: dpr=${m.dpr} fit=${m.fit} canvas=${s.canvas} targets=${m.glyphCount} found=${found.length}/${rs.length} caret=${caret}/${visible.length}${occl ? ` (${occl} occluded by UI)` : ""} 5pt=${ptsOk}/${ptsTested} centre-err/em mean=${(100 * s.meanRel).toFixed(1)}% max=${(100 * s.maxRel).toFixed(1)}% (${s.meanPx.toFixed(2)}px/${s.maxPx.toFixed(2)}px) ink-covered mean=${s.meanCover.toFixed(3)} min=${s.minCover.toFixed(3)} IoU=${s.meanIou.toFixed(3)} glyph-vs-box≤${gvb.toFixed(2)}px${worst ? " worst " + worst : ""}${missedCaret ? " caret-miss " + missedCaret : ""}`);
  // Acceptance — "perfectly aligned" in extension terms:
  //  • every character the game drew has a DOM glyph,
  //  • the rendered text box coincides with the OCR box (≤ 0.75 px),
  //  • caretRangeFromPoint at the ink centre resolves to that character for every visible glyph,
  //    and for ≥ 97 % of the 5 probe points per glyph (ink centre + inner quarter points),
  //  • the DOM glyph centre is within 12 % of the font size of the ink centre on average
  //    and never off by more than 45 % (punctuation is boxed as a full cell by the recognizer),
  //  • ≥ 90 % of every glyph's ink lies inside its DOM box on average.
  check(found.length === rs.length, `${label}: all ${rs.length} characters have a DOM glyph`);
  check(gvb <= 0.75, `${label}: rendered text box == OCR box (max deviation ${gvb.toFixed(2)} px)`);
  check(caret === visible.length, `${label}: caretRangeFromPoint at the ink centre resolves to the right character (${caret}/${visible.length})`);
  check(ptsOk >= Math.ceil(ptsTested * 0.97), `${label}: 5-point probes resolve to the right character (${ptsOk}/${ptsTested})`);
  check(s.meanRel <= 0.12 && s.maxRel <= 0.45, `${label}: centre error mean ${(100 * s.meanRel).toFixed(1)}% ≤ 12%, max ${(100 * s.maxRel).toFixed(1)}% ≤ 45% of font size`);
  check(s.meanCover >= 0.9, `${label}: ink covered by DOM box mean ${s.meanCover.toFixed(3)} ≥ 0.9`);
  return s;
}

async function settle(page, ms = 700, minTargets = 30) {
  // Auto mode re-scans on pointer movement (≥ 500 ms apart): nudge the pointer over the
  // canvas, then wait until the published text comes from a capture of the CURRENT canvas
  // backing store whose corner markers are found, and positions are stable.
  const fresh = () => page.evaluate(`(() => { const c = document.getElementById("canvas"); const m = window.__ppssppOcrDebug?.capture?.meta; if (!m || m.sourceWidth !== c.width || m.sourceHeight !== c.height) return false; if (document.querySelectorAll(".ocr-text-target").length < ${Math.min(minTargets, 30)}) return false; const r = (${MEASURE})([]); return !r.error; })()`);
  let prev = null;
  for (let i = 0; i < 40; i++) {
    const r = await page.evaluate(() => { const c = document.getElementById("canvas").getBoundingClientRect(); return { x: c.left + c.width / 2, y: c.top + c.height / 2 }; });
    await page.mouse.move(r.x + (i % 2 ? 6 : -6), r.y + (i % 3) * 4);
    await page.waitForTimeout(ms);
    if (!(await fresh())) { prev = null; continue; }
    const sig = await page.evaluate(() => Array.from(document.querySelectorAll(".ocr-text-target")).slice(0, 60).map((e) => { const r = e.getBoundingClientRect(); return `${r.left.toFixed(1)},${r.top.toFixed(1)}`; }).join("|"));
    if (sig === prev) return;
    prev = sig;
  }
}

async function bootAndEnable(context, viewport) {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}${PREFIX}/`);
  await page.waitForFunction(() => !!window.PpssppReadingBridge && window.crossOriginIsolated, null, { timeout: 30_000 });
  await page.evaluate(() => localStorage.setItem("ppsspp_ocr_debug", "1"));
  await page.setInputFiles("#gameFile", resolve("test-game/EBOOT.PBP"));
  await page.click("#startBtn");
  await page.waitForFunction(() => window.PpssppReadingBridge.getState().phase === "running", null, { timeout: 240_000 });
  await page.waitForTimeout(3000); // let the homebrew present a few frames
  await page.click("#ocrToggleBtn");
  await page.waitForFunction(() => /Ready/.test(document.querySelector("#ocrToggleBtn")?.title ?? "") || document.querySelectorAll(".ocr-text-target").length > 0, null, { timeout: 240_000, polling: 500 });
  await settle(page);
  return { page, errors };
}

async function measure(page, label, chars = CHARS) {
  await settle(page, 700, chars.length);
  const m = await page.evaluate(`(${MEASURE})(${JSON.stringify(chars)})`);
  return summarize(label, m);
}

// ───────────────────────── pass 1: DPR 1 ─────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const { page, errors } = await bootAndEnable(context, { width: 1600, height: 900 });
  check((await page.evaluate(() => window.PpssppReadingBridge.getState().gameId)) === "EBOOT.PBP", "game booted from a user-opened EBOOT.PBP (Open Game path)");
  const first = await page.evaluate(`(${MEASURE})(${JSON.stringify(CHARS)})`);
  check(!first.error && first.frame, `corner markers located in the OCR capture: frame ${JSON.stringify(first.frame)} → source ${JSON.stringify(first.src && Object.fromEntries(Object.entries(first.src).map(([k, v]) => [k, +v.toFixed(1)])))}`);
  await measure(page, "1600x900 panel closed");

  await page.click("#panelToggleBtn");
  await measure(page, "1600x900 panel open");

  await page.setViewportSize({ width: 1200, height: 700 });
  await measure(page, "1200x700 panel open");

  await page.click("#panelToggleBtn");
  await page.setViewportSize({ width: 900, height: 1000 });
  await measure(page, "900x1000 (tall) panel closed");

  await page.setViewportSize({ width: 412, height: 915 });
  await measure(page, "412x915 (phone)");

  await page.setViewportSize({ width: 1600, height: 900 });
  await measure(page, "back to 1600x900");

  // Layout shift without a resize: the canvas moves but keeps its size (a banner above the
  // stage, a horizontal shift when the canvas is height-limited …). The overlay must follow.
  await page.evaluate(() => { const s = document.querySelector(".stage"); s.style.paddingLeft = "140px"; s.style.paddingTop = "40px"; s.style.justifyContent = "flex-start"; });
  await page.waitForTimeout(1200);
  await measure(page, "canvas shifted by padding (no resize)");
  await page.evaluate(() => { const s = document.querySelector(".stage"); s.style.paddingLeft = ""; s.style.paddingTop = ""; s.style.justifyContent = ""; });
  await page.waitForTimeout(600);

  // Pure move: a CSS transform on the canvas changes no layout box at all (no ResizeObserver,
  // no resize/scroll event) — only the geometry watchdog can catch this.
  await page.evaluate(() => { document.getElementById("canvas").style.transform = "translate(-90px, 25px)"; });
  await page.waitForTimeout(1200);
  await measure(page, "canvas moved by transform (no layout change)");
  await page.evaluate(() => { document.getElementById("canvas").style.transform = ""; });
  await page.waitForTimeout(600);

  // Page scroll: make the document scrollable and scroll the canvas partly up.
  await page.evaluate(() => { document.documentElement.style.height = "auto"; document.body.style.height = "auto"; document.body.style.overflow = "auto"; const sp = document.createElement("div"); sp.id = "__spacer"; sp.style.height = "600px"; document.body.appendChild(sp); });
  await page.evaluate(() => window.scrollTo(0, 180));
  await page.waitForTimeout(800);
  const scrolled = await page.evaluate(() => window.scrollY);
  if (scrolled > 0) await measure(page, `page scrolled by ${scrolled}px`);
  else console.log("  (document not scrollable in this layout; scroll scenario skipped)");
  await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById("__spacer")?.remove(); document.documentElement.style.height = ""; document.body.style.height = ""; document.body.style.overflow = ""; });

  // Browser fullscreen (Element.requestFullscreen via the shell's button).
  await page.click("#fullscreenBtn");
  await page.waitForTimeout(1500);
  const fs = await page.evaluate(() => ({ el: document.fullscreenElement?.className ?? null, w: innerWidth, h: innerHeight, cls: document.body.className }));
  if (fs.el) {
    await measure(page, `fullscreen (${fs.el.split(" ")[0]} ${fs.w}x${fs.h})`);
    // (not via Escape: PPSSPP maps it to its pause menu)
    await page.evaluate(() => document.exitFullscreen?.().catch(() => {}));
    await page.waitForTimeout(1200);
    await measure(page, "after leaving fullscreen");
  } else {
    console.log(`  (fullscreen not granted by headless browser: ${JSON.stringify(fs)}; skipped)`);
  }

  // Scene change: Cross (keyboard Z in PPSSPP's default map) flips the homebrew to page 2;
  // OCR must re-scan and the new text must be aligned just the same.
  await page.click("#canvas", { position: { x: 20, y: 20 } });
  await page.keyboard.press("z");
  await page.waitForFunction(() => /戦闘|スライム/.test(Array.from(document.querySelectorAll(".ocr-text-target")).map((e) => e.textContent).join("")), null, { timeout: 60_000, polling: 500 }).catch(() => {});
  await measure(page, "page 2 after scene change", CHARS2);

  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(" | ")})`);
  await context.close();
}

// ───────────────────────── pass 2: DPR 2 ─────────────────────────
{
  const context = await browser.newContext({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 2 });
  const { page } = await bootAndEnable(context, { width: 1400, height: 800 });
  await measure(page, "DPR2 1400x800 panel closed");
  await page.click("#panelToggleBtn");
  await measure(page, "DPR2 1400x800 panel open");
  await context.close();
}

await browser.close();
server.close();
if (process.env.ALIGN_JSON) writeFileSync(process.env.ALIGN_JSON, JSON.stringify(results, null, 1));
console.log(failures === 0 ? "game alignment E2E: all checks passed" : `game alignment E2E: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
