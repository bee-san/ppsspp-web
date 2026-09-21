import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";
/**
 * Browser smoke test for the OCR layer wiring (no emulator build required):
 *   npm run build -- --configuration development
 *   npm i --no-save playwright && npx playwright install chromium
 *   node scripts/smoke-ocr.mjs
 * Serves dist/ppsspp-web with COOP/COEP, then verifies: reading bridge v1,
 * overlay + text layer mounted, consent → model download → "Ready (wasm)" via the
 * bundled worker, keydown input-claim gate, persisted settings, model cache, and
 * that a reload is ready again with zero .onnx network requests.
 */

const root = resolve("dist/ppsspp-web");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = join(root, path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => !!window.PpssppReadingBridge, null, { timeout: 30_000 });
const bridge = await page.evaluate(() => ({ version: window.PpssppReadingBridge.version, state: window.PpssppReadingBridge.getState(), canvas: !!window.PpssppReadingBridge.getCanvas(), stage: !!window.PpssppReadingBridge.getStage() }));
console.log("bridge:", JSON.stringify(bridge));
console.log("overlay host present:", await page.evaluate(() => !!document.getElementById("ocrOverlay") && document.getElementById("ocrOverlay").parentElement.classList.contains("stage")));
console.log("text layer mounted:", await page.evaluate(() => !!document.querySelector(".ocr-text-layer")));
// open OCR tab and enable
await page.evaluate(() => { document.body.classList.add("panel-open"); document.querySelector(".tab[data-tab=ocr]").click(); });
await page.click("#ocrToggleBtn");
await page.waitForSelector(".ocr-consent", { timeout: 10_000 });
console.log("consent prompt:", (await page.textContent(".ocr-status")).trim().slice(0, 90) + "…");
await page.click(".ocr-consent button.primary");
await page.waitForFunction(() => /^Ready/.test((document.querySelector(".ocr-status")?.textContent ?? "").trim()), null, { timeout: 180_000 });
console.log("status:", (await page.textContent(".ocr-status")).trim());
console.log("workers:", page.workers().map((w) => w.url().split("/").pop()));
// input claim gate check: with a claim, keydown must not reach a window listener registered later
const gate = await page.evaluate(() => {
  const b = window.PpssppReadingBridge;
  let seen = 0;
  window.addEventListener("keydown", () => seen++, true); // later listener, like SDL
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
  const release = b.setReadingInputClaim("test", true);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "x" }));
  release();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
  return { seenKeydowns: seen, hasClaimAfterRelease: b.hasInputClaim() };
});
console.log("input gate:", JSON.stringify(gate), "(expect seenKeydowns=2: before claim and after release)");
// Region selection: Escape must cancel even though the reading input claim blocks keydown for the emulator.
{
  const r = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll("button")].find((b) => /select text area/i.test(b.textContent));
    btn.click();
    await new Promise((r) => setTimeout(r, 50));
    const active = !!document.querySelector(".ocr-region-select");
    const claimed = window.PpssppReadingBridge.hasInputClaim();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    return { active, claimed, cancelled: !document.querySelector(".ocr-region-select"), claimReleased: !window.PpssppReadingBridge.hasInputClaim() };
  });
  console.log("region select Escape:", JSON.stringify(r), "(expect all true)");
}
// Disabling OCR must remove the readable text layer content and any input claim.
{
  await page.click("#ocrToggleBtn");
  await page.waitForTimeout(100);
  const r = await page.evaluate(() => ({ status: document.querySelector(".ocr-status").textContent.trim(), textTargets: document.querySelectorAll(".ocr-text-target").length, claims: window.PpssppReadingBridge.hasInputClaim() }));
  console.log("after disable:", JSON.stringify(r));
  await page.click("#ocrToggleBtn"); // re-enable for the reload check
  await page.waitForFunction(() => /^Ready/.test((document.querySelector(".ocr-status")?.textContent ?? "").trim()), null, { timeout: 60_000 });
}
console.log("settings persisted:", await page.evaluate(() => JSON.parse(localStorage.getItem("ppsspp_ocr_settings_v1")).enabled));
console.log("model cache present:", await page.evaluate(async () => (await caches.keys()).includes("meikiocr-web-assets-v1")));
// reload: models should come from Cache Storage (no network for .onnx)
const onnxRequests = [];
page.on("request", (r) => { if (r.url().endsWith(".onnx")) onnxRequests.push(r.url()); });
await page.reload();
await page.waitForFunction(() => /^Ready/.test((document.querySelector(".ocr-status")?.textContent ?? "").trim()), null, { timeout: 120_000 });
console.log("after reload: ready again; .onnx network requests:", onnxRequests.length);
if (logs.length) console.log("console errors/warnings:\n" + logs.filter((l) => !/favicon|WebGL2|GPU|AudioContext|Web Audio|sw\.js|serviceWorker|SW registered|COOP|SharedArrayBuffer/i.test(l)).slice(0, 15).join("\n"));
await browser.close();
server.close();
