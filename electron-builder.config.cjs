"use strict";
// electron-builder configuration (.cjs so it works next to the package's tooling).
// The engine (out/engine/index.js) is a CommonJS bundle with its dependencies left external, so production node_modules
// are packed with it. Natives (sharp, the keyring) cannot load from inside app.asar and are unpacked.
// The engine finds the player bundle (out/player) by walking up from out/engine, so it stays inside the archive.
module.exports = {
  appId: "dev.selak.cartoon-studio",
  productName: "Cartoon Studio",
  copyright: "Tihomir Selak",
  directories: { output: "release", buildResources: "build" },
  npmRebuild: false,
  asar: true,
  files: ["out/**/*", "!out/**/*.map", "package.json"],
  // Read from disk: the seed (main passes --seed) and the window/tray icon.
  extraResources: [
    { from: "seed", to: "seed" },
    { from: "build/icon.png", to: "icon.png" },
  ],
  asarUnpack: ["node_modules/sharp/**", "node_modules/@img/**", "node_modules/@napi-rs/**"],
  win: {
    icon: "build/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }, { target: "portable", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: "Cartoon-Studio-Setup-${version}-${arch}.${ext}",
  },
  portable: { artifactName: "Cartoon-Studio-Portable-${version}-${arch}.${ext}" },
};
