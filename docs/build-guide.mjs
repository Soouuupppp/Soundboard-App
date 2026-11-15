#!/usr/bin/env node
// Fills the generated blocks in docs/soundboard-guide.html so the prototype looks
// exactly like the app while staying one standalone file:
//   css   — Tailwind compiled with the app's own tailwind.config.ts + globals.css,
//           scanned against this HTML (so any class written in it just works)
//   icons — the lucide icons the HTML uses, copied from lucide-react
//   logo  — web/src/app/logo.png as a data URI
//
// Run after editing the prototype's markup/classes (text-only guide edits don't
// need it):   node docs/build-guide.mjs
// Needs the web workspace's node_modules (pnpm install). Idempotent.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const web = join(root, "web");
const htmlPath = join(here, "soundboard-guide.html");
const req = createRequire(join(web, "package.json"));

const postcss = req("postcss");
const tailwindcss = req("tailwindcss");
const loadConfig = req("tailwindcss/loadConfig");
const autoprefixer = req("autoprefixer");

const BLOCK = /(<!-- generated:start (\w+) -->)[\s\S]*?(<!-- generated:end \2 -->)/g;
let html = readFileSync(htmlPath, "utf8");
// Scan the hand-written source only, never the previous generated output.
const source = html.replace(BLOCK, "$1$3");

// --- CSS --------------------------------------------------------------------
const config = loadConfig(join(web, "tailwind.config.ts"));
config.content = [{ raw: source, extension: "html" }];
const globals = readFileSync(join(web, "src/app/globals.css"), "utf8");
const result = await postcss([tailwindcss(config), autoprefixer]).process(globals, { from: undefined });
const css = result.css;

// --- icons ------------------------------------------------------------------
// Icon names reach ic() as literals or through helpers (headerButton, addTab,
// GUIDES icon fields), so take every quoted word that is a lucide file name.
const iconDir = join(web, "node_modules/lucide-react/dist/esm/icons");
const names = new Set();
for (const m of source.matchAll(/['"]([a-z][a-z0-9]*(?:-[a-z0-9]+)*)['"]/g)) {
  if (existsSync(join(iconDir, `${m[1]}.js`))) names.add(m[1]);
}
const icons = {};
for (const name of [...names].sort()) {
  const file = join(iconDir, `${name}.js`);
  const src = readFileSync(file, "utf8");
  const m = src.match(/createLucideIcon\("[^"]+",\s*(\[[\s\S]*?\])\);/);
  if (!m) continue; // a non-icon module in that folder (e.g. index.js)
  // Trusted local library file: a plain array literal of [tag, attrs] pairs.
  const nodes = Function(`"use strict"; return (${m[1]});`)();
  icons[name] = nodes.map(([tag, attrs]) => {
    const a = Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ");
    return `<${tag} ${a}/>`;
  }).join("");
}

// --- logo -------------------------------------------------------------------
const logo = "data:image/png;base64," + readFileSync(join(web, "src/app/logo.png")).toString("base64");

const fill = {
  css: `\n<style>\n${css}\n</style>\n`,
  icons: `\n<script>var ICONS = ${JSON.stringify(icons)};</script>\n`,
  logo: `\n<script>var LOGO = ${JSON.stringify(logo)};</script>\n`,
};
html = html.replace(BLOCK, (all, start, name, end) => {
  if (!(name in fill)) throw new Error(`unknown generated block: ${name}`);
  return start + fill[name] + end;
});
writeFileSync(htmlPath, html);
console.log(`soundboard-guide.html: ${(html.length / 1024).toFixed(0)} KB, ${(css.length / 1024).toFixed(0)} KB css, ${Object.keys(icons).length} icons`);
