#!/usr/bin/env node
/**
 * Fetch the prebuilt PPSSPP WASM emulator pinned in emulator.lock.json into
 * <out>/build-wasm/ (default: public/build-wasm, so `ng build` ships it), verifying
 * SHA-256 and byte length. Prefer `make wasm-release` for a source build; this is
 * the reproducible fallback used by the Pages workflow.
 *
 *   node scripts/fetch-emulator.mjs [--out public] [--write-lock]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const outRoot = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : "public");
const writeLock = args.includes("--write-lock");
const lockPath = resolve("emulator.lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const outDir = join(outRoot, "build-wasm");
mkdirSync(outDir, { recursive: true });

let changed = false;
for (const f of lock.files) {
  const dst = join(outDir, f.name);
  let bytes;
  if (existsSync(dst)) {
    bytes = readFileSync(dst);
    if (createHash("sha256").update(bytes).digest("hex") === f.sha256) {
      console.log(`OK   ${f.name} (cached)`);
      continue;
    }
  }
  const url = lock.baseUrl + f.name;
  console.log(`GET  ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${f.name}: HTTP ${res.status}`);
  bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (writeLock) {
    if (f.sha256 !== sha || f.bytes !== bytes.byteLength) changed = true;
    f.sha256 = sha;
    f.bytes = bytes.byteLength;
  } else if (sha !== f.sha256 || bytes.byteLength !== f.bytes) {
    throw new Error(`${f.name}: integrity mismatch (got ${sha} ${bytes.byteLength} B, lock ${f.sha256} ${f.bytes} B). Upstream changed its build; review and re-run with --write-lock.`);
  }
  writeFileSync(dst, bytes);
  console.log(`OK   ${f.name} sha256=${sha} bytes=${bytes.byteLength}`);
}
if (writeLock) {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
  console.log(changed ? "lock updated" : "lock unchanged");
}
console.log(`emulator ready in ${outDir}`);
