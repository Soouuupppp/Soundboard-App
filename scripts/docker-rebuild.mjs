#!/usr/bin/env node
// Rebuild the web image with a rolling latest/prev tag scheme.
//
// Why this exists: `docker compose build` retags the freshly built image as
// soundboard-web:latest and *untags* the previous one, leaving it behind as a
// dangling <none> layer. Those accumulate and eat disk on both dev machines
// and the VPS. Instead we keep exactly two named images:
//   :latest — what's running now
//   :prev   — one build back, retained so a bad deploy can be rolled back
//             (see scripts/docker-rollback.mjs)
// and prune everything older.
//
// Flow: move :latest -> :prev, build the new :latest, prune the displaced
// layer, then bring the stack up.
//
// Flags (passed through to compose):
//   --env-file <path>   global compose env file (prod points at /home/soundboard/.env)
//   --detach | -d       run `up` detached (prod); omit for a foreground local run
import { execFileSync } from "node:child_process";

const IMAGE = "soundboard-web";

const args = process.argv.slice(2);
const envFileIdx = args.indexOf("--env-file");
const envFile = envFileIdx !== -1 ? args[envFileIdx + 1] : null;
const detach = args.includes("--detach") || args.includes("-d");
const composeGlobal = envFile ? ["--env-file", envFile] : [];

function run(cmd, cmdArgs) {
  console.log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  execFileSync(cmd, cmdArgs, { stdio: "inherit" });
}

// 1. Roll the current :latest down to :prev. No-op on the very first build,
//    when no :latest exists yet.
try {
  execFileSync("docker", ["image", "tag", `${IMAGE}:latest`, `${IMAGE}:prev`], { stdio: "ignore" });
  console.log(`tagged ${IMAGE}:latest -> ${IMAGE}:prev`);
} catch {
  console.log(`no existing ${IMAGE}:latest to keep as :prev (first build?)`);
}

// 2. Build the new image. compose tags it :latest via the `image:` field, which
//    removes that tag from the old image (now reachable only as :prev).
run("docker", ["compose", ...composeGlobal, "build"]);

// 3. Reclaim the layer that just lost its last tag (the build before :prev).
//    :latest and :prev are named, so they survive the prune.
run("docker", ["image", "prune", "-f"]);

// 4. Bring the stack up on the fresh image.
run("docker", ["compose", ...composeGlobal, "up", ...(detach ? ["-d"] : [])]);
