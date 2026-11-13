// Bundles src/plugin.ts (+ @elgato/streamdeck) into the .sdPlugin folder, per Elgato's
// TypeScript template. No watch/restart script on purpose: this repo never drives the
// Stream Deck app from scripts.
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "com.soouuupppp.soundboard.sdPlugin";

/** @type {import('rollup').RollupOptions} */
export default {
  input: "src/plugin.ts",
  output: { file: `${sdPlugin}/bin/plugin.js`, sourcemap: false },
  plugins: [
    typescript(),
    nodeResolve({ browser: false, exportConditions: ["node"], preferBuiltins: true }),
    commonjs(),
    terser(),
    {
      name: "emit-module-package-file",
      generateBundle() {
        this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
      },
    },
  ],
};
