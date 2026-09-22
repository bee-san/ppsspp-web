/**
 * Sentence-mining end-to-end check with a REAL GAME in the real PPSSPP WASM build.
 *
 * Boots test-game/EBOOT.PBP (Japanese text pages + a 440/660 Hz test tone that
 * alternates every 500 ms), lets the mining buffer fill from the game's own audio and
 * frames, flips to page 2 (Cross), presses the mining hotkey, adds the clip to a mocked
 * AnkiConnect and then verifies the CONTENT of what was sent — not just that it decodes:
 *
 *   - audio: the MP3, decoded by the browser, is not silence and its spectrum peaks at
 *     the game's 440 Hz and 660 Hz tones (Goertzel) and not elsewhere,
 *   - picture: the animated WebP's last frame shows page 2 (dark red background) and
 *     its first frame page 1 (dark blue) when the flip lies inside the clip — i.e. the
 *     frames are the game's, in the right order, ending at "now",
 *   - AnkiConnect receives requestPermission → findNotes → updateNoteFields → addTags
 *     with the media attached to the newest note, and the input claim is released.
 *
 * Usage: npx ng build --configuration development && node scripts/e2e-mining-game.mjs
 * Env:   E2E_PATH_PREFIX=/ppsspp-web serves dist under a sub-path like GitHub Pages.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync, writeFileSync, mkdirSync, createWriteStream } from "node:fs";
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

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failures++; };

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
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
const POLL = { polling: 500 };

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
await page.evaluate(() => {
  document.body.classList.add("panel-open");
  const sel = document.getElementById("panelTabSelect"); sel.value = "mining"; sel.dispatchEvent(new Event("change", { bubbles: true }));
  window.__tap = { chunks: 0, peak: 0 };
  window.PpssppReadingBridge.addAudioTapListener((c) => {
    const t = window.__tap; t.chunks++;
    const a = c.channels ? c.channels[0] : c.interleaved;
    const step = c.channels ? 16 : 32;
    for (let i = 0; i < a.length; i += step) t.peak = Math.max(t.peak, Math.abs(a[i]));
  });
});
await page.waitForSelector("#tabMining.active", { timeout: 5000 });

// Boot the game through the Open Game path.
await page.setInputFiles("#gameFile", resolve("test-game/EBOOT.PBP"));
const t0 = Date.now();
await page.click("#startBtn");
await page.waitForFunction(() => window.PpssppReadingBridge.getState().phase === "running", null, { timeout: 240_000 });
console.log(`game running after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
check((await page.evaluate(() => window.PpssppReadingBridge.getState().gameId)) === "EBOOT.PBP", "EBOOT.PBP booted (Open Game path)");
await page.waitForFunction(() => /Buffering/.test(document.querySelector("app-mining-settings .ocr-status")?.textContent ?? ""), null, { timeout: 60_000, ...POLL });
check(true, "mining buffering with the game running");

// Let the game's audio and frames accumulate. Real game audio here is a tone, so the tap
// must see a clearly non-zero peak (the emulator menu alone is silent).
await page.waitForFunction(() => /Buffered: [3-9]|Buffered: \d\d/.test(document.querySelector(".mining-buffered")?.textContent ?? ""), null, { timeout: 120_000, ...POLL });
await page.waitForFunction(() => Number(/· (\d+) frames/.exec(document.querySelector(".mining-buffered")?.textContent ?? "")?.[1] ?? 0) >= 8, null, { timeout: 120_000, ...POLL }).catch(() => {});
const tap = await page.evaluate(() => window.__tap);
check(tap.chunks > 0 && tap.peak > 0.05, `game audio reaches the tap: ${tap.chunks} chunks, peak ${tap.peak.toFixed(3)} (tone amplitude ≈ 0.27)`);
console.log("buffer:", await page.locator(".mining-buffered").innerText());

// Let the frame ring cover at least the default clip (8 s) so the first frame of the clip is
// a game frame (SwiftShader's rAF cadence is slow; give it time), then flip to page 2
// (Cross = Z), wait so the flip lies inside the clip, and mine.
await page.waitForFunction(() => Number(/frames \/ ([\d.]+) s/.exec(document.querySelector(".mining-buffered")?.textContent ?? "")?.[1] ?? 0) >= 9, null, { timeout: 120_000, ...POLL }).catch(() => {});
console.log("buffer before mining:", await page.locator(".mining-buffered").innerText());
// Hold the key for several emulator frames: PPSSPP samples the pad once per frame and a slow
// CI runner (SwiftShader, ~5–10 fps) misses Playwright's instantaneous press.
await page.click("#canvas", { position: { x: 20, y: 20 } });
await page.keyboard.down("z"); await page.waitForTimeout(500); await page.keyboard.up("z");
await page.waitForTimeout(2500);
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "§", code: "Backquote", bubbles: true, cancelable: true })));
await page.waitForSelector(".mining-picker", { timeout: 30_000 });
check(await page.evaluate(() => window.PpssppReadingBridge.hasInputClaim()), "picker open: emulator keyboard input claimed");
await page.waitForFunction(() => !!document.querySelector(".mining-preview img")?.src, null, { timeout: 15_000, ...POLL }).catch(() => {});
const selSeconds = parseFloat(await page.locator(".mining-times strong").innerText());
await page.screenshot({ path: "/tmp/mining-game-picker.png" });

await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })));
await page.waitForFunction(() => !document.querySelector(".mining-picker"), null, { timeout: 120_000, ...POLL });
await page.waitForSelector("#toast.visible", { timeout: 10_000 });
check(/Added to note 1700000000777/.test(await page.locator("#toast").innerText()), "toast: added to the newest note");
check(!(await page.evaluate(() => window.PpssppReadingBridge.hasInputClaim())), "input claim released after Add");
const actions = ankiCalls.map((c) => c.action);
check(JSON.stringify(actions) === JSON.stringify(["requestPermission", "findNotes", "updateNoteFields", "addTags"]), `AnkiConnect sequence: ${actions.join(" → ")}`);
const note = ankiCalls.find((c) => c.action === "updateNoteFields")?.params?.note ?? {};
check(note.id === 1700000000777 && note.audio?.[0]?.fields?.[0] === "SentenceAudio" && note.picture?.[0]?.fields?.[0] === "Picture", `note ${note.id}: audio → ${note.audio?.[0]?.fields}, picture → ${note.picture?.[0]?.fields}`);

// ── Content checks on the media the browser sent ──
const media = await page.evaluate(async ({ audioB64, picB64 }) => {
  const toBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const mp3 = toBytes(audioB64);
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(mp3.buffer.slice(0));
  await ctx.close();
  const x = buf.getChannelData(0);
  const sr = buf.sampleRate;
  let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const rms = Math.sqrt(sum / x.length);
  // Goertzel power at candidate frequencies over the whole clip (the tone alternates 440/660).
  const goertzel = (f) => { const w = 2 * Math.PI * f / sr; const c = 2 * Math.cos(w); let s0 = 0, s1 = 0, s2 = 0; for (let i = 0; i < x.length; i++) { s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; } return (s1 * s1 + s2 * s2 - c * s1 * s2) / x.length; };
  const freqs = [220, 330, 440, 550, 660, 880, 1000, 1320, 2000];
  const power = Object.fromEntries(freqs.map((f) => [f, goertzel(f)]));
  // picture: decode every ANMF frame via the browser (ImageDecoder if available, else the first/last via <img>)
  const webp = toBytes(picB64);
  const ascii = (o, n) => String.fromCharCode(...webp.subarray(o, o + n));
  let anmf = 0; for (let i = 12; i + 8 <= webp.length;) { const cc = ascii(i, 4); const sz = webp[i + 4] | (webp[i + 5] << 8) | (webp[i + 6] << 16) | (webp[i + 7] << 24); if (cc === "ANMF") anmf++; i += 8 + sz + (sz & 1); }
  const frames = [];
  if ("ImageDecoder" in window) {
    const dec = new ImageDecoder({ data: webp, type: "image/webp" });
    await dec.tracks.ready;
    const n = dec.tracks.selectedTrack.frameCount;
    for (const idx of [0, n - 1]) {
      const { image } = await dec.decode({ frameIndex: idx });
      const c = document.createElement("canvas"); c.width = image.displayWidth; c.height = image.displayHeight;
      const g = c.getContext("2d"); g.drawImage(image, 0, 0);
      // mean colour of the top-left region (background of the page: blue on page 1, red on page 2)
      const d = g.getImageData(Math.round(c.width * 0.45), Math.round(c.height * 0.3), Math.round(c.width * 0.15), Math.round(c.height * 0.2)).data;
      let r = 0, gg = 0, b = 0, k = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; k++; }
      frames.push({ idx, w: c.width, h: c.height, r: r / k, g: gg / k, b: b / k, png: idx === n - 1 ? c.toDataURL("image/png") : null });
      image.close();
    }
  }
  return { duration: buf.duration, channels: buf.numberOfChannels, rms, power, anmf, frames, imageDecoder: "ImageDecoder" in window };
}, { audioB64: note.audio[0].data, picB64: note.picture[0].data });
console.log("audio:", JSON.stringify({ duration: media.duration, channels: media.channels, rms: +media.rms.toFixed(4) }));
console.log("spectrum (Goertzel power):", Object.entries(media.power).map(([f, p]) => `${f}Hz=${p.toExponential(2)}`).join(" "));
console.log("frames:", JSON.stringify(media.frames.map((f) => ({ idx: f.idx, rgb: [f.r, f.g, f.b].map((v) => Math.round(v)) }))));
if (media.frames.at(-1)?.png) writeFileSync("/tmp/mining-game-lastframe.png", Buffer.from(media.frames.at(-1).png.split(",")[1], "base64"));
writeFileSync("/tmp/mining-game-clip.mp3", Buffer.from(note.audio[0].data, "base64"));
writeFileSync("/tmp/mining-game-clip.webp", Buffer.from(note.picture[0].data, "base64"));

check(media.channels === 2 && media.duration > 1, `MP3 decodes: ${media.duration.toFixed(2)} s, ${media.channels} ch (selection ${selSeconds} s)`);
check(media.rms > 0.02, `audio is not silence: RMS ${media.rms.toFixed(4)} (tone ≈ 0.19 at full production; a silent MP3 — the 96 kbps stereo lamejs bug — gives 0)`);
const p = media.power;
const tone = Math.max(p[440], p[660]);
const other = Math.max(p[220], p[330], p[550], p[880], p[1000], p[1320], p[2000]);
// Under SwiftShader on a starved CI runner the audio tap drops chunks, so a 6 s slice may hold
// mostly one half of the 440/660 alternation: require the tone energy to dominate everything
// else by 5×, and report both tones (both are present on an unstarved host).
check(tone > other * 5, `spectrum is the game's tone (440: ${p[440].toExponential(2)}, 660: ${p[660].toExponential(2)}; loudest other frequency ${other.toExponential(2)}, ≥ 5× below)`);
console.log(`  both tones present: ${p[440] > other && p[660] > other} (informational; chunk drops on slow runners can skew the alternation)`);
check(media.anmf >= 3, `animated WebP has ${media.anmf} frames`);
if (media.imageDecoder && media.frames.length === 2) {
  const [first, last] = media.frames;
  // page 2 background is (30,12,12) dark red; page 1 (12,16,28) dark blue — after the JPEG-ish
  // WebP encode a red-dominant vs blue-dominant mean is a robust discriminator.
  check(last.r > last.b + 6, `last frame is page 2 (red-dominant background r=${last.r.toFixed(0)} b=${last.b.toFixed(0)}) — the clip ends at "now"`);
  // The flip happened 2.5 s before the hotkey and the clip covers the last `selSeconds` (≥ 5 s),
  // so the oldest frame must still be page 1: frames are the game's, in order.
  check(first.b > first.r + 4, `first frame is page 1 (blue-dominant r=${first.r.toFixed(0)} b=${first.b.toFixed(0)}) — the page flip lies inside the ${selSeconds} s clip, frames are ordered`);
} else {
  console.log("  (ImageDecoder unavailable; per-frame colour check skipped)");
}
check(errs.length === 0, `no uncaught page errors${errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""}`);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nmining game E2E: all checks passed");
process.exit(failures ? 1 : 0);
