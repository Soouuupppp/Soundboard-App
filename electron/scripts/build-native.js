// Build the native sidecars (C++) and stage them for packaging.
//
// Runs CMake against electron/native/vr-bridge and electron/native/audio-capture,
// then copies the results into electron/resources/{vr,audio-capture}, which
// electron-builder ships via extraResources. Windows-only.
//
// Requires: CMake on PATH (or $CMAKE) and the VS 2022 "Desktop development with
// C++" workload. Override the generator with $CMAKE_GENERATOR if needed.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") {
  console.warn("[build-native] native sidecars are Windows-only — skipping.");
  process.exit(0);
}

const cmake = process.env.CMAKE || "cmake";
const generator = process.env.CMAKE_GENERATOR || "Visual Studio 17 2022";

function run(args) {
  console.log(`[build-native] cmake ${args.join(" ")}`);
  execFileSync(cmake, args, { stdio: "inherit" });
}

function build(sourceName, stagedName, artifacts) {
  const sourceDir = path.join(__dirname, "..", "native", sourceName);
  const buildDir = path.join(sourceDir, "build");
  const releaseDir = path.join(buildDir, "Release");
  const outDir = path.join(__dirname, "..", "resources", stagedName);

  try {
    run(["-S", sourceDir, "-B", buildDir, "-G", generator, "-A", "x64"]);
    run(["--build", buildDir, "--config", "Release"]);
  } catch (e) {
    console.error(
      "[build-native] CMake build failed. Ensure CMake and the VS 2022 C++ " +
        "workload are installed.\n" + (e && e.message)
    );
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const f of artifacts) {
    fs.copyFileSync(path.join(releaseDir, f), path.join(outDir, f));
  }
  console.log(`[build-native] staged ${artifacts.length} files -> resources/${stagedName}`);
}

build("vr-bridge", "vr", [
  "vr-bridge.exe",
  "openvr_api.dll",
  "soundboard_actions.json",
  "bindings_knuckles.json",
  "bindings_touch.json",
]);
build("audio-capture", "audio-capture", ["audio-capture.exe"]);
