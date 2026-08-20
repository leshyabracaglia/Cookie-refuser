#!/usr/bin/env node
// Builds the Chrome or Firefox extension package from the canonical manifest.json,
// patching the one field where the two stores have contradictory requirements:
//
//   - Chrome's MV3 validator rejects "background.scripts" outright
//     ("'background.scripts' requires manifest version of 2 or lower").
//   - Firefox doesn't run background service workers; it needs "scripts" as a
//     fallback or AMO validation fails ("Unsupported /background/service_worker
//     ... without /background/scripts property as Firefox-compatible fallback").
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SHARED_FILES = ["background.js", "content.js", "content.css", "popup.html", "popup.js"];

const target = process.argv[2];
if (target !== "chrome" && target !== "firefox") {
  console.error("Usage: node scripts/build.js <chrome|firefox>");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

if (target === "firefox") {
  manifest.background.scripts = ["background.js"];
} else {
  delete manifest.background.scripts;
}

const stageDir = path.join(ROOT, "build", target);
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, "icons"), { recursive: true });

fs.writeFileSync(path.join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const file of SHARED_FILES) {
  fs.copyFileSync(path.join(ROOT, file), path.join(stageDir, file));
}
for (const icon of fs.readdirSync(path.join(ROOT, "icons"))) {
  fs.copyFileSync(path.join(ROOT, "icons", icon), path.join(stageDir, "icons", icon));
}

const zipName = `cookie-refuser-${target}.zip`;
const zipPath = path.join(ROOT, zipName);
fs.rmSync(zipPath, { force: true });
execSync(`zip -r ${JSON.stringify(zipName)} . -x '*.DS_Store'`, { cwd: stageDir, stdio: "inherit" });
fs.renameSync(path.join(stageDir, zipName), zipPath);
fs.rmSync(stageDir, { recursive: true, force: true });

console.log(`Built ${zipName}`);
