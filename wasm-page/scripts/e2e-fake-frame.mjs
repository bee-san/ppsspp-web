#!/usr/bin/env node
/**
 * Ground-truth harness (plan §14A "fake-frame harness before emulator integration"),
 * run against the REAL built app in headless Chromium — no emulator, no model mocks.
 *
 * The game canvas (#canvas) is driven with a 2D context and known Japanese text at
 * known pixel boxes; the reading bridge is put into the "running" phase via its
 * internal hook. Then, with the real OCR worker and models, we verify:
 *   1. recognized text equals what was drawn (per line),
 *   2. hovering the centre of each drawn character activates exactly that glyph
 *      (pointer → capture image → layout → hit → DOM), incl. after a CSS resize,
 *   3. a region selection restricts recognition to that region and mapping stays exact,
 *   4. a scene change replaces the text; an unchanged scene runs no inference,
 *   5. manual (hold-key) mode: rising edge captures once, text hidden on key up,
 *   6. popup presentation stays inside the stage bounds with MeikiPop placement,
 *   7. Yomitan's DOMTextScanner reads each paragraph as a continuous run.
 *
 * Usage: npx ng build --configuration development && node scripts/e2e-fake-frame.mjs
 * Requires a Japanese font on the host (Noto/Droid Sans Japanese) for canvas text.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve("dist/ppsspp-web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css" };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.startsWith("/scripts/") ? join(resolve("scripts"), path.slice("/scripts/".length)) : join(root, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => !!window.PpssppReadingBridge, null, { timeout: 30_000 });
await page.evaluate(() => localStorage.setItem("ppsspp_ocr_debug", "1"));

// ---- Fake game: draw scenes on #canvas with a 2D context; report exact glyph boxes via measureText.
await page.evaluate(() => {
  const c = document.getElementById("canvas");
  c.width = 960; c.height = 544; // 2x PSP, 16:9 like the shell's CSS box
  const ctx = c.getContext("2d");
  window.__fake = {
    ctx,
    scene(lines, bg = "#101828") {
      ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
      const out = [];
      for (const l of lines) {
        ctx.font = `${l.size}px "Noto Sans CJK JP", "Droid Sans Japanese", "Noto Sans JP", sans-serif`;
        ctx.textBaseline = "top"; ctx.fillStyle = l.color ?? "#ffffff";
        let x = l.x;
        const chars = [];
        for (const ch of Array.from(l.text)) {
          const m = ctx.measureText(ch);
          ctx.fillText(ch, x, l.y);
          // Ink centre (not cell centre): the recognizer boxes the visible ink, exactly like
          // the native reference, so "。" sits in the lower-left of its cell.
          const inkL = x - m.actualBoundingBoxLeft, inkR = x + m.actualBoundingBoxRight;
          const inkT = l.y - m.actualBoundingBoxAscent, inkB = l.y + m.actualBoundingBoxDescent;
          chars.push({ ch, cx: (inkL + inkR) / 2, cy: (inkT + inkB) / 2 });
          x += m.width;
        }
        out.push({ text: l.text, chars });
      }
      return out;
    },
  };
  // Put the bridge in the running phase (test-only use of the runtime's internal hook).
  window.PpssppReadingBridge._started();
  window.PpssppReadingBridge._setPhase("running");
});
const SCENE1 = [
  { text: "一生懸命に走った。", x: 60, y: 60, size: 30 },
  { text: "明日も晴れるでしょう", x: 60, y: 130, size: 26, color: "#ffe08a" },
  { text: "終了", x: 700, y: 420, size: 34 },
];
let truth = await page.evaluate((s) => window.__fake.scene(s), SCENE1);

// canvas source px -> client px
const toClient = async (sx, sy) => page.evaluate(([sx, sy]) => {
  const c = document.getElementById("canvas"); const r = c.getBoundingClientRect();
  const bl = c.clientLeft, bt = c.clientTop, w = c.clientWidth, h = c.clientHeight;
  return { x: r.left + bl + (sx / c.width) * w, y: r.top + bt + (sy / c.height) * h };
}, [sx, sy]);

// ---- Enable OCR
await page.evaluate(() => { document.body.classList.add("panel-open"); document.querySelector(".tab[data-tab=ocr]").click(); });
await page.click("#ocrToggleBtn");
await page.waitForFunction(() => /^Ready/.test((document.querySelector(".ocr-status")?.textContent ?? "").trim()), null, { timeout: 180_000 });
const waitLayout = async (pred, timeout = 20_000) => page.waitForFunction(pred, null, { timeout }).then(() => true, () => false);
// Text per source line, whatever the DOM strategy (line spans or per-glyph spans tagged with data-ocr-line).
const lineTextsFn = `(() => { const m = new Map(); for (const e of document.querySelectorAll(".ocr-text-target")) { const id = e.dataset.ocrLine ?? e.dataset.ocrGlyph; m.set(id, (m.get(id) ?? "") + e.textContent); } return [...m.values()]; })()`;
const targetsText = () => page.evaluate(lineTextsFn);
await page.evaluate((src) => Object.defineProperty(window, "LINES", { get: () => eval(src) }), lineTextsFn);
const diagNum = (key) => page.evaluate((k) => Number(new RegExp(k + "=([\\d,]+)").exec(document.querySelector(".ocr-diag")?.textContent ?? "")?.[1]?.replace(/,/g, "") ?? -1), key);
await page.evaluate(() => { const cb = [...document.querySelectorAll("#tabOcr input[type=checkbox]")].find((i) => /diagnostics/i.test(i.parentElement?.textContent ?? "")); if (cb && !cb.checked) cb.click(); });

// 1. recognized text == drawn text (initial scan)
check(await waitLayout(() => document.querySelectorAll(".ocr-text-target").length >= 3), "initial scan produced text targets");
// Invisible overlay by default (MeikiPop-like): transparent text, still hit-testable; debug toggle paints it.
{
  const st = await page.evaluate(() => { const e = document.querySelector(".ocr-text-target"); const c = getComputedStyle(e); return { color: c.color, vis: c.visibility, pe: c.pointerEvents, invisibleClass: e.closest(".ocr-text-layer").classList.contains("ocr-invisible-text") }; });
  check(st.invisibleClass && st.color === "rgba(0, 0, 0, 0)" && st.vis === "visible" && st.pe === "auto", `overlay text is transparent but hit-testable by default: ${JSON.stringify(st)}`);
  await page.evaluate(() => { const cb = [...document.querySelectorAll("#tabOcr input[type=checkbox]")].find((i) => /show recognized text/i.test(i.parentElement?.textContent ?? "")); cb.click(); });
  await page.waitForTimeout(150);
  const on = await page.evaluate(() => getComputedStyle(document.querySelector(".ocr-text-target")).color);
  check(on !== "rgba(0, 0, 0, 0)", `debug toggle paints the text (${on})`);
  await page.evaluate(() => { const cb = [...document.querySelectorAll("#tabOcr input[type=checkbox]")].find((i) => /show recognized text/i.test(i.parentElement?.textContent ?? "")); cb.click(); });
  await page.waitForTimeout(150);
  check(await page.evaluate(() => getComputedStyle(document.querySelector(".ocr-text-target")).color === "rgba(0, 0, 0, 0)"), "toggle off → transparent again");
  // What a dictionary extension does at the pointer (Yomitan: caretRangeFromPoint → text node + offset)
  // must resolve to the invisible OCR text, at (or next to) the hovered character — for both DOM strategies.
  const caretCheck = async (label) => {
    let caretOk = 0, caretTotal = 0; const caretMiss = [];
    for (const line of truth) for (const g of line.chars) {
      caretTotal++;
      const p = await toClient(g.cx, g.cy);
      const r = await page.evaluate(([x, y]) => { const rg = document.caretRangeFromPoint(x, y); if (!rg) return null; const n = rg.startContainer; const t = n.nodeType === 3 ? n.data : (n.textContent ?? ""); return { text: t, off: rg.startOffset, inLayer: !!(n.parentElement ?? n).closest?.(".ocr-text-layer") }; }, [p.x, p.y]);
      const near = r && r.inLayer && [r.off - 1, r.off, r.off + 1].some((i) => r.text[i] && r.text[i].normalize("NFKC") === g.ch.normalize("NFKC"));
      if (near) caretOk++; else caretMiss.push(`${g.ch}→${r ? `${r.text}@${r.off}${r.inLayer ? "" : "/not-layer"}` : "null"}`);
    }
    console.log(`  caret ${label}: ${caretOk}/${caretTotal}${caretMiss.length ? " — " + caretMiss.slice(0, 6).join(" ") : ""}`);
    return caretOk === caretTotal;
  };
  const setStrategy = async (v) => { await page.evaluate((v) => { const sel = [...document.querySelectorAll("#tabOcr select")].find((s) => [...s.options].some((o) => o.value === "glyph-spans")); sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); }, v); await page.waitForTimeout(200); };
  await setStrategy("line-text");
  const lineTextOk = await caretCheck("line-text (informational; uniform spacing drifts on ink-bounded boxes)");
  await setStrategy("glyph-spans"); // the default
  check(await caretCheck("glyph-spans (default)"), "default per-character layer: extension caret hit-test lands on the hovered character for every glyph");
  console.log(`  caret summary: line-text ${lineTextOk ? "exact" : "drifts"}, glyph-spans exact`);
}
let texts = await targetsText();
const nfkc = (t) => t.normalize("NFKC");
const want = SCENE1.map((l) => l.text);
check(want.every((t) => texts.map(nfkc).includes(nfkc(t))), `recognized == drawn (NFKC): ${JSON.stringify(texts)}`);

// 2. per-character hit mapping
async function hoverAll(label) {
  let ok = 0, total = 0, misses = [];
  for (const line of truth) {
    for (const g of line.chars) {
      total++;
      const p = await toClient(g.cx, g.cy);
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(25);
      const active = await page.evaluate(() => ({ glyph: document.querySelector(".ocr-active-target")?.textContent ?? null, hl: document.querySelector(".ocr-active-glyph"), hlHidden: document.querySelector(".ocr-active-glyph")?.hidden }));
      // line-text strategy: active target is the line; the highlight box marks the glyph
      const hlBox = await page.evaluate(() => { const h = document.querySelector(".ocr-active-glyph"); if (!h || h.hidden) return null; const r = h.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
      const inside = hlBox && p.x >= hlBox.l - 1 && p.x <= hlBox.r + 1 && p.y >= hlBox.t - 1 && p.y <= hlBox.b + 1;
      const lineOk = active.glyph && active.glyph.normalize("NFKC").includes(g.ch.normalize("NFKC"));
      if (lineOk && inside) ok++; else misses.push(`${g.ch}:${active.glyph ?? "none"}${inside ? "" : "/outside"}`);
    }
  }
  check(ok === total, `${label}: ${ok}/${total} characters hit exactly${misses.length ? " — misses " + misses.slice(0, 6).join(" ") : ""}`);
}
await hoverAll("hover each drawn character");

// pointer over background => no active text
{
  const p = await toClient(480, 300);
  await page.mouse.move(p.x, p.y); await page.waitForTimeout(40);
  check(await page.evaluate(() => !document.querySelector(".ocr-active-target")), "pointer over scenery → no active text");
}

// Yomitan scanner continuity
{
  const y = await page.evaluate(async () => {
    const mod = await import("/scripts/yomitan-scanner/dom-text-scanner.js");
    return [...document.querySelectorAll(".ocr-paragraph")].map((p) => { const sp = [...p.querySelectorAll(".ocr-text-target")]; const exp = sp.map((s) => s.textContent).join(""); return { exp, got: sp.length ? new mod.DOMTextScanner(sp[0].firstChild, 0, false, true).seek(exp.length).content : "" }; });
  });
  check(y.length > 0 && y.every((p) => p.exp === p.got), `Yomitan scanner: ${y.length} paragraphs continuous`);
}

// 3. CSS resize (zoom the stage): no inference, mapping still exact
{
  const scans0 = await diagNum("submitted");
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.waitForTimeout(400);
  await hoverAll("after CSS resize (viewport 1200x700)");
  check((await diagNum("submitted")) === scans0, "CSS resize caused no inference");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForTimeout(300);
}

// 4. unchanged scene: hovering around yields no new inference; scene change replaces text
{
  const before = await diagNum("submitted");
  for (let i = 0; i < 8; i++) { const p = await toClient(100 + i * 40, 75); await page.mouse.move(p.x, p.y); await page.waitForTimeout(120); }
  await page.waitForTimeout(700);
  check((await diagNum("submitted")) === before, "unchanged pixels → no additional inference while moving");
  const SCENE2 = [{ text: "セーブしますか？", x: 80, y: 200, size: 32 }];
  truth = await page.evaluate((s) => window.__fake.scene(s, "#202020"), SCENE2);
  const p = await toClient(200, 215); await page.mouse.move(p.x + 3, p.y); // movement triggers the scan
  const replaced = await waitLayout(() => { const t = LINES.map((x) => x.normalize("NFKC")); return t.length === 1 && t[0] === "セーブしますか？".normalize("NFKC"); });
  check(replaced, `scene change replaced text: ${JSON.stringify(await targetsText())}`);
  await hoverAll("scene 2 characters");
}

// 5. region selection: restrict to the lower-right area of a two-block scene
{
  const SCENE3 = [{ text: "上のテキスト", x: 60, y: 40, size: 30 }, { text: "下の選択肢", x: 600, y: 440, size: 30 }];
  truth = await page.evaluate((s) => window.__fake.scene(s), SCENE3);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /select text area/i.test(b.textContent)).click());
  await page.waitForSelector(".ocr-region-select");
  const a = await toClient(560, 400), b = await toClient(940, 520);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
  const ok = await waitLayout(() => { const t = LINES; return t.length === 1 && t[0] === "下の選択肢"; });
  check(ok, `region restricts recognition: ${JSON.stringify(await targetsText())}`);
  truth = truth.filter((l) => l.text === "下の選択肢");
  await hoverAll("region-cropped characters");
  const img = await page.evaluate(() => /image=(\d+x\d+)/.exec(document.querySelector(".ocr-diag")?.textContent ?? "")?.[1]);
  console.log(`  region capture image: ${img}`);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /full viewport/i.test(b.textContent)).click());
  await page.waitForTimeout(300);
}

// 6. manual (hold-key) mode: rising edge captures once; key up hides; repeat ignored
{
  await page.evaluate(() => { const cb = [...document.querySelectorAll("#tabOcr input[type=checkbox]")].find((i) => /auto scan/i.test(i.parentElement?.textContent ?? "")); if (cb?.checked) cb.click(); });
  await page.waitForTimeout(200);
  truth = await page.evaluate((s) => window.__fake.scene(s, "#0b1a2a"), [{ text: "手動モードの文", x: 100, y: 240, size: 34 }]);
  // The previous step's "Full viewport" reset may still have a throttled scan pending; let the
  // controller settle (no active inference, submitted count stable) before counting, otherwise
  // that late submission is misattributed to the held key (observed flake: 4 → 6).
  for (let last = -1, stableSince = Date.now(); ; ) {
    const n = await diagNum("submitted");
    const active = /active=true|pending=\S/.test(await page.evaluate(() => document.querySelector(".ocr-diag")?.textContent ?? ""));
    if (n !== last) { last = n; stableSince = Date.now(); }
    if (!active && Date.now() - stableSince > 900) break;
    await page.waitForTimeout(150);
  }
  const before = await diagNum("submitted");
  const p = await toClient(200, 258); await page.mouse.move(p.x, p.y);
  await page.keyboard.down("Shift");
  const shown = await waitLayout(() => LINES.some((x) => x === "手動モードの文") && getComputedStyle(document.querySelector(".ocr-text-target")).visibility !== "hidden");
  check(shown, "manual mode: Shift rising edge captured and text is visible while held");
  // key repeat events must not capture again
  for (let i = 0; i < 5; i++) await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", repeat: true, bubbles: true })));
  await page.waitForTimeout(600);
  check((await diagNum("submitted")) === before + 1, `exactly one capture for held key (+repeats): submitted ${before} → ${await diagNum("submitted")}`);
  await hoverAll("manual mode characters (key held)");
  await page.keyboard.up("Shift");
  await page.waitForTimeout(100);
  check(await page.evaluate(() => getComputedStyle(document.querySelector(".ocr-text-target")).visibility === "hidden"), "key released → text hidden (cache retained)");
  await page.evaluate(() => { const cb = [...document.querySelectorAll("#tabOcr input[type=checkbox]")].find((i) => /auto scan/i.test(i.parentElement?.textContent ?? "")); if (!cb?.checked) cb.click(); });
  await page.waitForTimeout(800);
}

// 7. popup presentation: MeikiPop placement inside stage bounds, follows pointer, hides off-text
{
  await page.selectOption("#tabOcr select[aria-label='Presentation'], #tabOcr select", { label: /popup|card/i }).catch(async () => {
    await page.evaluate(() => { const sel = [...document.querySelectorAll("#tabOcr select")].find((s) => [...s.options].some((o) => /popup|card/i.test(o.textContent))); const o = [...sel.options].find((o) => /popup|card/i.test(o.textContent)); sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); });
  });
  await page.waitForTimeout(300);
  truth = await page.evaluate((s) => window.__fake.scene(s), [{ text: "ポップアップ確認", x: 80, y: 60, size: 30 }, { text: "右下の文", x: 700, y: 470, size: 30 }]);
  let p = await toClient(90, 76); await page.mouse.move(p.x + 2, p.y);
  const got = await waitLayout(() => { const el = document.querySelector(".ocr-popup"); return !!el && !el.hidden && /ポップアップ確認/.test(el.textContent ?? ""); });
  check(got, "popup shows the full paragraph for the hovered text");
  const inBounds = async () => page.evaluate(() => { const el = document.querySelector(".ocr-popup"); const s = document.getElementById("ocrOverlay").parentElement.getBoundingClientRect(); const r = el.getBoundingClientRect(); return { ok: r.left >= s.left - 1 && r.top >= s.top - 1 && r.right <= s.right + 1 && r.bottom <= s.bottom + 1, r: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], s: [Math.round(s.left), Math.round(s.top), Math.round(s.right), Math.round(s.bottom)], below: r.top > 0 } });
  const b1 = await inBounds();
  check(b1.ok, `popup within stage bounds (upper-left text): ${JSON.stringify(b1.r)} in ${JSON.stringify(b1.s)}`);
  p = await toClient(760, 486); await page.mouse.move(p.x, p.y); await page.waitForTimeout(150);
  const b2 = await inBounds();
  const popupTop = b2.r[1], pointerY = p.y;
  check(b2.ok && popupTop < pointerY, `popup within bounds and ABOVE the pointer for lower-third text (top ${popupTop} < pointer ${Math.round(pointerY)})`);
  p = await toClient(480, 300); await page.mouse.move(p.x, p.y); await page.waitForTimeout(500);
  check(await page.evaluate(() => { const el = document.querySelector(".ocr-popup"); return !el || el.hidden; }), "popup hidden when pointer leaves text");
  check(await page.evaluate(() => document.querySelectorAll(".ocr-text-target").length === 0), "popup mode: no duplicate spatial text layer (one scannable presentation)");
}

if (logs.length) console.log("page errors:\n" + logs.slice(0, 10).join("\n"));
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nfake-frame harness: all checks passed");
process.exit(failures ? 1 : 0);
