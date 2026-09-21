#!/usr/bin/env node
/**
 * Export OCR runtime assets into public/ocr-assets/ so the Angular build ships
 * them (immutable, same-origin). Runs meikiocr-web's tools from node_modules:
 *   1. fetch-models  — downloads the pinned ONNX models and verifies them
 *                      against meikiocr-web/models.lock.json (SHA-256, bytes)
 *   2. export-assets — copies models + the MATCHING onnxruntime-web wasm/mjs
 *                      files and writes manifest.json
 *
 * Usage: npm run ocr:export-assets
 * Model files (~46 MB) are gitignored; CI/Pages runs this before `ng build`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Resolve the package root via its ESM main entry (dist/index.js → ../).
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.resolve("meikiocr-web"))), "..");
const out = resolve("public/ocr-assets");
const modelsDir = join(pkgRoot, "models");
mkdirSync(out, { recursive: true });

function run(script, args) {
  const r = spawnSync(process.execPath, [join(pkgRoot, "tools", script), ...args], { stdio: "inherit", cwd: pkgRoot });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("fetch-models.mjs", ["--out", modelsDir, "--lock", join(pkgRoot, "models.lock.json")]);
run("export-assets.mjs", ["--out", out, "--models", modelsDir, "--lock", join(pkgRoot, "models.lock.json")]);
if (!existsSync(join(out, "manifest.json"))) {
  console.error("manifest.json missing after export");
  process.exit(1);
}
console.log(`OCR assets ready in ${out}`);
