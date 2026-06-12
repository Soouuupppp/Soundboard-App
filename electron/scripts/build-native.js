// Build the native VR controller bridge (C++/OpenVR) and stage it for packaging.
//
// Runs CMake against electron/native/vr-bridge, then copies the exe + the
// openvr runtime DLL + the action manifests into electron/resources/vr, which
// electron-builder ships via extraResources. Windows-only.
//
// Requires: CMake on PATH (or $CMAKE) and the VS 2022 "Desktop development with
// C++" workload. Override the generator with $CMAKE_GENERATOR if needed.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") {
  console.warn("[build-native] VR bridge is Windows-only — skipping.");
  process.exit(0);
}

const bridgeDir = path.join(__dirname, "..", "native", "vr-bridge");
const buildDir = path.join(bridgeDir, "build");
const releaseDir = path.join(buildDir, "Release");
const outDir = path.join(__dirname, "..", "resources", "vr");

const cmake = process.env.CMAKE || "cmake";
const generator = process.env.CMAKE_GENERATOR || "Visual Studio 17 2022";

function run(args) {
  console.log(`[build-native] cmake ${args.join(" ")}`);
  execFileSync(cmake, args, { stdio: "inherit" });
}

try {
  run(["-S", bridgeDir, "-B", buildDir, "-G", generator, "-A", "x64"]);
  run(["--build", buildDir, "--config", "Release"]);
} catch (e) {
  console.error(
    "[build-native] CMake build failed. Ensure CMake and the VS 2022 C++ " +
      "workload are installed.\n" + (e && e.message)
  );
  process.exit(1);
}

const artifacts = [
  "vr-bridge.exe",
  "openvr_api.dll",
  "soundboard_actions.json",
  "bindings_knuckles.json",
  "bindings_touch.json",
];

fs.mkdirSync(outDir, { recursive: true });
for (const f of artifacts) {
  fs.copyFileSync(path.join(releaseDir, f), path.join(outDir, f));
}
console.log(`[build-native] staged ${artifacts.length} files -> resources/vr`);
