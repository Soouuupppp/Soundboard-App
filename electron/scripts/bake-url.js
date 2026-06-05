// Writes electron/baked.json with the build-time URL so it gets bundled into
// the packaged app. Run automatically before `electron-builder`.
//
// URL resolution order (first non-empty wins):
//   1. $SOUNDBOARD_URL env var (ad-hoc / CI override)
//   2. "soundboardUrl" field in electron/package.json (versioned default)

const fs = require("fs");
const path = require("path");

const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const pkgUrl = typeof pkg.soundboardUrl === "string" ? pkg.soundboardUrl.trim() : "";

const url = (process.env.SOUNDBOARD_URL || pkgUrl || "").trim();
const outPath = path.join(__dirname, "..", "baked.json");

fs.writeFileSync(outPath, JSON.stringify({ url }, null, 2));

if (url) {
  const source = process.env.SOUNDBOARD_URL ? "$SOUNDBOARD_URL" : "package.json#soundboardUrl";
  console.log(`[bake-url] baked ${url} (from ${source}) into ${outPath}`);
} else {
  console.warn(
    "[bake-url] No URL configured — the packaged app will prompt the user on first launch.\n" +
      "          Set one via either:\n" +
      "            - electron/package.json  \"soundboardUrl\": \"https://soundboard.example.com\"\n" +
      "            - $env:SOUNDBOARD_URL = 'https://soundboard.example.com'   (PowerShell, one-off)\n" +
      "            - SOUNDBOARD_URL=https://soundboard.example.com pnpm dist  (POSIX, one-off)"
  );
}
