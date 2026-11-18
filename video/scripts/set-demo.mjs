#!/usr/bin/env node
// Swap the Scene 2 placeholder for assets/demo.mp4 and match every duration to the clip.
//   node scripts/set-demo.mjs            # uses the clip's own length
//   node scripts/set-demo.mjs 72.5       # or force a scene length in seconds
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clip = join(root, "assets/demo.mp4");
const S1 = 40, S3 = 15;

let len = Number(process.argv[2]);
if (!len) {
  if (!existsSync(clip)) throw new Error("assets/demo.mp4 not found; pass a length in seconds instead");
  len = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip]).toString().trim());
}
len = Math.round(len * 100) / 100;
const total = Math.round((S1 + len + S3) * 100) / 100;

// index.html: scene slot, root length, the cut whoosh into the outro
const idxPath = join(root, "index.html");
let idx = readFileSync(idxPath, "utf8");
idx = idx.replace(/(id="demo"[\s\S]*?data-duration=")[\d.]+(")/, `$1${len}$2`);
idx = idx.replace(/(data-composition-id="main"[\s\S]*?data-duration=")[\d.]+(")/, `$1${total}$2`);
idx = idx.replace(/(id="sfx-cut2"[^>]*data-start=")[\d.]+(")/, `$1${(S1 + len - 0.13).toFixed(2)}$2`);
writeFileSync(idxPath, idx);

// demo.html: callouts last to the scene end; placeholder → video when the clip exists
const demoPath = join(root, "compositions/demo.html");
let demo = readFileSync(demoPath, "utf8");
demo = demo.replace(/(<div id="d-c\d" class="clip" data-start=")([\d.]+)(" data-duration=")[\d.]+(")/g,
  (_, a, start, b, c) => `${a}${start}${b}${Math.max(0.5, len - Number(start)).toFixed(2)}${c}`);
if (existsSync(clip)) {
  const video = `<video id="d-clip" class="clip" src="assets/demo.mp4" muted playsinline data-start="0" data-duration="${len}" data-track-index="0" style="position:absolute;left:0;top:0;width:1274px;height:714px;object-fit:contain;background:#05080b"></video>`;
  demo = demo.replace(/(<!-- DEMO-CLIP[^\n]*-->\n)[\s\S]*?(\s*<!-- \/DEMO-CLIP -->)/, `$1        ${video}$2`);
} else {
  demo = demo.replace(/(id="d-placeholder" class="clip" data-start="0" data-duration=")[\d.]+(")/, `$1${len}$2`);
}
writeFileSync(demoPath, demo);
console.log(`Scene 2 = ${len}s, film = ${total}s${existsSync(clip) ? ", clip placed" : " (placeholder kept)"}`);
