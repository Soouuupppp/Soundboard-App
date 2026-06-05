// Writes electron/baked.json with the URL from $SOUNDBOARD_URL so it gets
// bundled into the packaged app. Run automatically before `electron-builder`.

const fs = require("fs");
const path = require("path");

const url = process.env.SOUNDBOARD_URL || "";
const outPath = path.join(__dirname, "..", "baked.json");

fs.writeFileSync(outPath, JSON.stringify({ url }, null, 2));

if (url) {
  console.log(`[bake-url] baked SOUNDBOARD_URL=${url} into ${outPath}`);
} else {
  console.warn(
    "[bake-url] SOUNDBOARD_URL is not set — the packaged app will prompt the user on first launch.\n" +
      "          Set it before building, e.g.:\n" +
      "            $env:SOUNDBOARD_URL = 'https://soundboard.example.com'   (PowerShell)\n" +
      "            SOUNDBOARD_URL=https://soundboard.example.com pnpm dist:win"
  );
}
