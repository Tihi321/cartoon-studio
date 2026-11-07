// Verifies the unpacked Windows build (release/win-unpacked): the app files, the resources the engine reads from disk,
// and that the native modules (sharp, keyring) load from app.asar.unpacked when the exe runs as Node (ELECTRON_RUN_AS_NODE=1).
// It never starts the app window or any service. Exit code 0 on success. Usage: node scripts/verify-package.mjs [unpackedDir]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unpackedDir = path.resolve(process.argv[2] ?? path.join(root, "release", "win-unpacked"));
const exe = path.join(unpackedDir, "Cartoon Studio.exe");
const resources = path.join(unpackedDir, "resources");
const unpacked = path.join(resources, "app.asar.unpacked");
const asar = path.join(resources, "app.asar");

// The built code the app and the engine load from the archive (the engine finds the player bundle by walking up from out/engine).
const FILES = ["out/main/index.js", "out/preload/index.js", "out/renderer/index.html", "out/engine/index.js", "out/player/index.html", "package.json"];

const failures = [];
const check = (ok, message) => { console.log(`${ok ? "ok  " : "FAIL"} ${message}`); if (!ok) failures.push(message); };

check(fs.existsSync(exe), `exe present: ${exe}`);
check(fs.existsSync(asar), "resources/app.asar present");
if (failures.length) { console.error("\nverify-package FAILED: build the unpacked app first (yarn dist:dir)"); process.exit(1); }

// What the app and the engine read from disk.
check(fs.existsSync(path.join(resources, "icon.png")), "resources/icon.png (window and tray icon)");
check(fs.existsSync(path.join(resources, "seed", "config", "settings.md")), "resources/seed/config/settings.md (main passes --seed)");
for (const dir of ["agents"]) check(fs.existsSync(path.join(resources, "seed", dir)), `resources/seed/${dir}`);
const sourceConfigs = fs.readdirSync(path.join(root, "seed", "config")).filter((f) => f.endsWith(".md"));
const packagedConfigs = fs.existsSync(path.join(resources, "seed", "config")) ? fs.readdirSync(path.join(resources, "seed", "config")).filter((f) => f.endsWith(".md")) : [];
check(sourceConfigs.length > 0 && sourceConfigs.length === packagedConfigs.length, `every seed/config file is packaged (${packagedConfigs.length} of ${sourceConfigs.length})`);

// The built code is inside the archive (read with Electron's asar support: node's fs under ELECTRON_RUN_AS_NODE).
const probe = `
const fs = require("node:fs"), path = require("node:path");
const app = ${JSON.stringify(asar)}, un = ${JSON.stringify(unpacked)};
const out = {};
for (const f of ${JSON.stringify(FILES)}) out[f] = fs.existsSync(path.join(app, f));
const nm = (name) => path.join(un, "node_modules", ...name.split("/"));
out.unpackedSharp = fs.existsSync(nm("sharp/package.json"));
out.unpackedKeyring = fs.existsSync(nm("@napi-rs/keyring/package.json"));
try { const sharp = require(path.join(app, "node_modules", "sharp")); out.sharp = Object.keys(sharp.versions || {}).length ? "ok " + sharp.versions.sharp : "loaded"; } catch (e) { out.sharp = "ERR " + String(e.message).slice(0, 160); }
try { const k = require(path.join(app, "node_modules", "@napi-rs", "keyring")); out.keyring = typeof k.Entry === "function" ? "ok" : "loaded"; } catch (e) { out.keyring = "ERR " + String(e.message).slice(0, 160); }
for (const m of ["yaml", "zod", "chokidar", "@modelcontextprotocol/sdk/package.json"]) { try { require.resolve(m, { paths: [app] }); out[m] = true; } catch { out[m] = false; } }
console.log(JSON.stringify(out));
`;
let result;
const probeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cts-verify-")), "probe.cjs");
fs.writeFileSync(probeFile, probe);
try {
  const stdout = execFileSync(exe, [probeFile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true, timeout: 60000 });
  result = JSON.parse(stdout.trim().split("\n").pop());
} catch (error) {
  check(false, `probe under ELECTRON_RUN_AS_NODE failed: ${error.message.split("\n")[0]}`);
}
fs.rmSync(path.dirname(probeFile), { recursive: true, force: true });
if (result) {
  for (const f of FILES) check(result[f] === true, `app.asar contains ${f}`);
  check(result.unpackedSharp && result.unpackedKeyring, "sharp and keyring are in app.asar.unpacked");
  check(String(result.sharp).startsWith("ok"), `sharp loads: ${result.sharp}`);
  check(String(result.keyring).startsWith("ok"), `keyring loads: ${result.keyring}`);
  for (const m of ["yaml", "zod", "chokidar", "@modelcontextprotocol/sdk/package.json"]) check(result[m] === true, `runtime dependency resolves from app.asar: ${m}`);
}

if (failures.length) { console.error(`\nverify-package FAILED (${failures.length})`); process.exit(1); }
console.log("\nverify-package passed");
