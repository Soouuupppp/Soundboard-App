#!/usr/bin/env node
// Roll back the web service to the previous image after a bad deploy.
//
// Points soundboard-web:latest back at the :prev image kept by
// scripts/docker-rebuild.mjs, then restarts the stack on it without
// rebuilding. There is only one step of history, so run this once — a second
// run would just re-promote the same image.
//
// Flags (same as docker-rebuild.mjs): --env-file <path>, --detach | -d
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

// Bail out clearly if there's nothing to roll back to.
try {
  execFileSync("docker", ["image", "inspect", `${IMAGE}:prev`], { stdio: "ignore" });
} catch {
  console.error(`No ${IMAGE}:prev image found — nothing to roll back to.`);
  process.exit(1);
}

run("docker", ["image", "tag", `${IMAGE}:prev`, `${IMAGE}:latest`]);
console.log(`promoted ${IMAGE}:prev -> ${IMAGE}:latest`);

// --no-build so we run the prev image as-is rather than rebuilding from source.
run("docker", ["compose", ...composeGlobal, "up", ...(detach ? ["-d"] : []), "--no-build"]);
