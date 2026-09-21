import { createServer } from "node:http";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { chromium } from "playwright";

/**
 * Sentence-mining end-to-end check against the REAL PPSSPP WASM build in headless
 * Chromium (SwiftShader). No game image is needed: the emulator's own menu renders
 * frames and its SDL audio device pumps PCM through the ScriptProcessor shim.
 * Verifies:
 *   - bridge v2 audio tap receives chunks from the running emulator (real
 *     makeScriptProcessorShim().pushOne()), the ring buffer fills at wall-clock rate,
 *   - continuous rAF capture of the WebGL canvas yields non-blank WebP frames,
 *   - hotkey → picker → Add produces an MP3 the browser can decode (duration matches
 *     the selection) and an animated WebP the browser can decode (VP8X+ANIM+ANMF),
 *     and sends them to AnkiConnect (mocked) with the expected request sequence,
 *   - the input claim is released and OCR's bridge connection is unaffected.
 *
 * Usage: npx ng build --configuration development && node scripts/e2e-mining.mjs
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
const PREFIX = (process.env.E2E_PATH_PREFIX ?? "").replace(/\/$/, "");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css", ".data": "application/octet-stream" };
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
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const notFound = [];
page.on("response", (r) => { if (r.status() === 404) notFound.push(r.url()); });

// Mocked AnkiConnect on the default URL.
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

await page.addInitScript(() => localStorage.setItem("ppsspp_mining_debug", "1"));
await page.goto(`http://127.0.0.1:${port}${PREFIX}/`);
await page.waitForFunction(() => !!window.PpssppReadingBridge && window.crossOriginIsolated, null, { timeout: 30_000 });
check(await page.evaluate(() => window.PpssppReadingBridge.version >= 2 && typeof window.PpssppReadingBridge.addAudioTapListener === "function"), "reading bridge v2 with audio tap");

// Open the Mining tab before starting so its diagnostics tick from the beginning.
await page.evaluate(() => {
  document.body.classList.add("panel-open");
  const sel = document.getElementById("panelTabSelect"); sel.value = "mining"; sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForSelector("#tabMining.active", { timeout: 5000 });
check(/Waiting for the game/.test(await page.locator("app-mining-settings .ocr-status").innerText()), "mining idle before the emulator runs");

// Independent tap observer (like the plan's DevTools demo) to count raw chunks from the runtime.
await page.evaluate(() => {
  window.__tap = { chunks: 0, frames: 0, sampleRate: 0, planar: 0, interleaved: 0, peak: 0 };
  window.PpssppReadingBridge.addAudioTapListener((c) => {
    const t = window.__tap; t.chunks++; t.frames += c.frames; t.sampleRate = c.sampleRate;
    if (c.channels) { t.planar++; for (let i = 0; i < c.frames; i += 64) t.peak = Math.max(t.peak, Math.abs(c.channels[0][i])); }
    else { t.interleaved++; for (let i = 0; i < c.frames; i += 64) t.peak = Math.max(t.peak, Math.abs(c.interleaved[i * 2])); }
  });
});

const t0 = Date.now();
await page.click("#startBtn");
await page.waitForFunction(() => window.PpssppReadingBridge.getState().phase === "running", null, { timeout: 240_000 });
console.log(`emulator running after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.waitForFunction(() => /Buffering/.test(document.querySelector("app-mining-settings .ocr-status")?.textContent ?? ""), null, { timeout: 10_000 });
check(true, "mining switched to buffering on phase=running");

// Let audio + frames accumulate; measure the buffer growth rate against wall-clock.
const readBuffered = async () => {
  const txt = await page.locator(".mining-buffered").innerText();
  const m = /Buffered: ([\d.]+) s @ (\d+) Hz × (\d)ch · (\d+) frames \(([^)]+)\)/.exec(txt);
  return m ? { s: Number(m[1]), sr: Number(m[2]), ch: Number(m[3]), frames: Number(m[4]), mem: m[5], txt } : { txt };
};
await page.waitForFunction(() => /Buffered: [1-9]/.test(document.querySelector(".mining-buffered")?.textContent ?? ""), null, { timeout: 60_000 }).catch(() => {});
const b1 = await readBuffered();
const w1 = Date.now();
await page.waitForTimeout(4000);
const b2 = await readBuffered();
const elapsed = (Date.now() - w1) / 1000;
// Show the diagnostics block (capture-loop counters) for the log.
await page.evaluate(() => { const cb = [...document.querySelectorAll("#tabMining input[type=checkbox]")].find((i) => /diagnostics/i.test(i.parentElement?.textContent ?? "")); if (cb && !cb.checked) cb.click(); });
await page.waitForTimeout(600);
console.log("diagnostics:", (await page.locator("#tabMining .ocr-diag").innerText().catch(() => "n/a")).replace(/\s+/g, " "));
const tap = await page.evaluate(() => ({ ...window.__tap, audioDebug: { callbacks: window.audioDebug?.callbacks, pushes: window.audioDebug?.pushes, rate: window.audioDebug?.rate }, ctxStates: (window.trackedAudioContexts ?? []).map((c) => c.state) }));
console.log("tap:", JSON.stringify(tap));
console.log(`buffer: ${b1.txt}  →  ${b2.txt}  (${elapsed.toFixed(1)} s wall)`);
check(tap.chunks > 0 && tap.frames > 0 && tap.sampleRate >= 22050, `audio tap delivered ${tap.chunks} chunks / ${tap.frames} frames @ ${tap.sampleRate} Hz (planar ${tap.planar}, interleaved ${tap.interleaved}) from the real SP shim`);
check(b2.s > 0 && b2.sr === tap.sampleRate && b2.ch === 2, `ring buffer holds ${b2.s} s @ ${b2.sr} Hz × ${b2.ch}ch`);
const growth = (b2.s ?? 0) - (b1.s ?? 0);
check(growth > elapsed * 0.6 && growth < elapsed * 1.4, `buffer grows at wall-clock rate: +${growth.toFixed(1)} s in ${elapsed.toFixed(1)} s`);
check(b2.frames >= 8, `continuous WebGL capture stored ${b2.frames} non-blank WebP frames (${b2.mem})`);

// Hotkey → picker. Dispatch on window like a real key reaching the capture-phase gate.
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "§", code: "Backquote", bubbles: true, cancelable: true })));
await page.waitForSelector(".mining-picker", { timeout: 10_000 });
check(await page.evaluate(() => window.PpssppReadingBridge.hasInputClaim()), "picker open: emulator keyboard input claimed");
await page.waitForTimeout(500);
// Preview frame: decode the blob the picker shows and make sure it is a real (non-black) WebP of the menu.
const preview = await page.evaluate(async () => {
  const img = document.querySelector(".mining-preview img");
  if (!img) return null;
  const blob = await (await fetch(img.src)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d"); ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let nz = 0; for (let i = 0; i < d.length; i += 16) if (d[i] | d[i + 1] | d[i + 2]) nz++;
  return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height, nonBlackPct: (100 * nz / (d.length / 16)).toFixed(1), png: c.toDataURL("image/png") };
});
check(preview && preview.type === "image/webp" && preview.w <= 480 && Number(preview.nonBlackPct) > 5, `preview frame is a decodable WebP ${preview?.w}x${preview?.h}, ${preview?.nonBlackPct}% non-black (${preview?.size} B)`);
if (preview) writeFileSync("/tmp/mining-emu-frame.png", Buffer.from(preview.png.split(",")[1], "base64"));
await page.screenshot({ path: "/tmp/mining-emu-picker.png" });
const durLabel = await page.locator(".mining-times strong").innerText();
const selSeconds = parseFloat(durLabel);
console.log("selection:", durLabel);

// Add (Enter) → encode → mocked Anki.
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })));
await page.waitForFunction(() => !document.querySelector(".mining-picker"), null, { timeout: 60_000 });
await page.waitForSelector("#toast.visible", { timeout: 5000 });
const toast = await page.locator("#toast").innerText();
check(/Added to note 1700000000777/.test(toast), `toast: ${toast}`);
check(!(await page.evaluate(() => window.PpssppReadingBridge.hasInputClaim())), "input claim released after Add");
const actions = ankiCalls.map((c) => c.action);
check(JSON.stringify(actions) === JSON.stringify(["requestPermission", "findNotes", "updateNoteFields", "addTags"]), `AnkiConnect sequence: ${actions.join(" → ")}`);
const upd = ankiCalls.find((c) => c.action === "updateNoteFields");
const note = upd?.params?.note ?? {};
check(note.id === 1700000000777 && note.audio?.[0]?.fields?.[0] === "SentenceAudio" && note.picture?.[0]?.fields?.[0] === "Picture", `updateNoteFields → note ${note.id}, fields ${note.audio?.[0]?.fields}/${note.picture?.[0]?.fields}`);

// Validate the media the browser would have sent: decode both with the browser itself.
const media = await page.evaluate(async ({ audioB64, picB64 }) => {
  const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const mp3 = toBytes(audioB64);
  const ctx = new AudioContext();
  let decoded = null;
  try { const buf = await ctx.decodeAudioData(mp3.buffer.slice(0)); decoded = { duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate }; } catch (e) { decoded = { error: String(e) }; }
  await ctx.close();
  const webp = toBytes(picB64);
  const ascii = (o, n) => String.fromCharCode(...webp.subarray(o, o + n));
  let anmf = 0; for (let i = 12; i + 8 <= webp.length;) { const cc = ascii(i, 4); const sz = webp[i + 4] | (webp[i + 5] << 8) | (webp[i + 6] << 16) | (webp[i + 7] << 24); if (cc === "ANMF") anmf++; i += 8 + sz + (sz & 1); }
  const img = new Image(); img.src = URL.createObjectURL(new Blob([webp], { type: "image/webp" }));
  let imgOk = false; try { await img.decode(); imgOk = true; } catch {}
  return { mp3Bytes: mp3.length, sync: mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0, decoded, webpBytes: webp.length, riff: ascii(0, 4) === "RIFF" && ascii(8, 12 - 8) === "WEBP", vp8x: ascii(12, 4) === "VP8X", anmf, imgOk, imgW: img.naturalWidth, imgH: img.naturalHeight };
}, { audioB64: note.audio[0].data, picB64: note.picture[0].data });
console.log("media:", JSON.stringify(media));
const dbg = await page.evaluate(() => { const d = window.__ppssppMiningDebug; return d ? { selection: d.selection, audio: d.audio, frameCount: d.frames.length, firstFrame: d.frames[0], lastFrame: d.frames[d.frames.length - 1], framesUsed: d.framesUsed } : null; });
console.log("debug snapshot:", JSON.stringify(dbg));
// Under SwiftShader the WASM emulator hogs the main thread and the SP shim drops audio (worklet
// underruns), so a wall-clock selection can hold less than its length in samples. The buffer's
// mark-based mapping keeps audio and frames aligned to wall-clock regardless; the MP3 must match
// the samples actually in the selection, and the snapshot's audio end must be "now" (not lagging).
const sliceSeconds = (dbg?.audio?.sliceMs ?? selSeconds * 1000) / 1000;
const productionRatio = sliceSeconds / selSeconds;
console.log(`audio produced in the selection: ${sliceSeconds.toFixed(2)} s of ${selSeconds} s wall-clock (ratio ${productionRatio.toFixed(2)})`);
check(dbg && Math.abs(dbg.audio.endMs - dbg.lastFrame) < 400 && dbg.framesUsed === dbg.frameCount, `snapshot audio end (${dbg?.audio?.endMs?.toFixed(0)} ms) aligns with the newest frame (${dbg?.lastFrame?.toFixed(0)} ms); ${dbg?.framesUsed}/${dbg?.frameCount} frames in range`);
check(productionRatio > 0.5, `audio production ratio ${productionRatio.toFixed(2)} (≈1 on real hardware; lower under SwiftShader)`);
check(media.sync && media.decoded && !media.decoded.error && Math.abs(media.decoded.duration - sliceSeconds) < 0.15 && media.decoded.channels === 2, `MP3 decodes in-browser: ${media.decoded?.duration?.toFixed(2)} s (selected audio ${sliceSeconds.toFixed(2)} s), ${media.decoded?.channels} ch, ${media.mp3Bytes} B`);
const expectedBytes = sliceSeconds * 96_000 / 8;
check(media.mp3Bytes > expectedBytes * 0.7 && media.mp3Bytes < expectedBytes * 1.5, `MP3 size consistent with 96 kbps (${media.mp3Bytes} B vs ~${Math.round(expectedBytes)} B)`);
check(media.riff && media.vp8x && media.anmf >= 3 && media.imgOk && media.imgW <= 480 && media.imgW > 0, `animated WebP decodes in-browser: ${media.anmf} frames, ${media.imgW}x${media.imgH}, ${media.webpBytes} B`);
writeFileSync("/tmp/mining-emu-clip.webp", Buffer.from(note.picture[0].data, "base64"));
writeFileSync("/tmp/mining-emu-clip.mp3", Buffer.from(note.audio[0].data, "base64"));
console.log(`audio peak seen by the tap: ${tap.peak.toFixed(4)} (the PPSSPP menu is normally silent; 0 is expected without a game)`);

// OCR must still see the (v2) bridge.
await page.evaluate(() => { const sel = document.getElementById("panelTabSelect"); sel.value = "ocr"; sel.dispatchEvent(new Event("change", { bubbles: true })); });
const ocrStatus = await page.locator("app-ocr-settings .ocr-status").innerText();
check(!/bridge not available/i.test(ocrStatus), `OCR status with bridge v2: "${ocrStatus.trim()}"`);

const errs = logs.filter((l) => /^\[pageerror\]/.test(l));
check(errs.length === 0, `no uncaught page errors${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
if (process.env.E2E_VERBOSE) console.log("relevant console:\n" + logs.filter((l) => /mining|AUDIO|tap|error/i.test(l) && !/favicon|sw\.js|Service/i.test(l)).slice(0, 30).join("\n"));
await browser.close();
server.close();
check(notFound.length === 0, `no 404 responses under prefix "${PREFIX || "/"}" ${notFound.length ? JSON.stringify(notFound.slice(0, 5)) : ""}`);
console.log(failures ? `\n${failures} check(s) FAILED` : "\nmining emulator E2E: all checks passed");
process.exit(failures ? 1 : 0);
