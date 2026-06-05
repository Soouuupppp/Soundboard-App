// Passthrough global hotkeys backed by uiohook-napi.
//
// Unlike Electron's built-in `globalShortcut` (which uses RegisterHotKey /
// CGEventTap in "swallow" mode and *blocks* the key from reaching other apps),
// uiohook is a low-level keyboard listener — it only *observes*. The key still
// fires in whatever app currently has focus.
//
// Public API:
//   start({ onMatch })   — begin listening; onMatch(combo) fires for each known combo.
//   stop()               — tear down the hook.
//   setCombos(combos)    — replace the active set of combos to watch (array of strings).
//   validateCombo(combo) — returns { ok, reason } without registering anything.
//
// Combo grammar matches the web side: "Ctrl+Shift+F5", "Space", "A".

let uIOhook = null;
let UiohookKey = null;
try {
  ({ uIOhook, UiohookKey } = require("uiohook-napi"));
} catch (e) {
  console.warn(
    "[hotkeys] uiohook-napi is not installed — global hotkeys will be disabled.\n" +
      "         Run: pnpm --filter electron install"
  );
}

// Build keyname → uIOhook keycode map (only valid keys allowed in combos).
function buildKeyMap() {
  if (!UiohookKey) return new Map();
  const map = new Map();
  const add = (name, code) => {
    if (typeof code === "number") map.set(name.toUpperCase(), code);
  };
  // Letters
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(65 + i);
    add(ch, UiohookKey[ch]);
  }
  // Digits (UiohookKey exposes these as e.g. UiohookKey['0'])
  for (let i = 0; i <= 9; i++) add(String(i), UiohookKey[String(i)]);
  // Function keys
  for (let i = 1; i <= 24; i++) add(`F${i}`, UiohookKey[`F${i}`]);
  // Common non-letter keys
  for (const name of [
    "Space",
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "Insert",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ]) {
    add(name, UiohookKey[name]);
  }
  return map;
}

const KEY_MAP = buildKeyMap();
const MODIFIER_TOKENS = new Set(["CTRL", "SHIFT", "ALT", "META"]);

function parseCombo(combo) {
  if (typeof combo !== "string") return null;
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return null;

  const mods = { ctrl: false, shift: false, alt: false, meta: false };
  let mainKeycode = null;
  let mainKeyName = null;

  for (const raw of parts) {
    const tok = raw.toUpperCase();
    if (MODIFIER_TOKENS.has(tok)) {
      if (tok === "CTRL") mods.ctrl = true;
      else if (tok === "SHIFT") mods.shift = true;
      else if (tok === "ALT") mods.alt = true;
      else if (tok === "META") mods.meta = true;
    } else {
      if (mainKeycode !== null) return null; // more than one non-modifier
      const code = KEY_MAP.get(tok);
      if (typeof code !== "number") return null;
      mainKeycode = code;
      mainKeyName = tok;
    }
  }
  if (mainKeycode === null) return null;
  return { mods, keycode: mainKeycode, mainKeyName };
}

function validateCombo(combo) {
  const p = parseCombo(combo);
  if (!p) return { ok: false, reason: "unrecognized key combination" };
  return { ok: true, parsed: p };
}

// --- Runtime state ---------------------------------------------------------

let started = false;
let registry = []; // [{ combo, mods, keycode }]
let onMatchFn = null;

function setCombos(combos) {
  const seen = new Set();
  registry = [];
  for (const combo of combos || []) {
    if (seen.has(combo)) continue;
    seen.add(combo);
    const v = validateCombo(combo);
    if (!v.ok) {
      console.warn(`[hotkeys] ignoring invalid combo "${combo}": ${v.reason}`);
      continue;
    }
    registry.push({ combo, ...v.parsed });
  }
}

function handleKeydown(e) {
  if (registry.length === 0) return;
  for (const r of registry) {
    if (
      r.keycode === e.keycode &&
      r.mods.ctrl === !!e.ctrlKey &&
      r.mods.shift === !!e.shiftKey &&
      r.mods.alt === !!e.altKey &&
      r.mods.meta === !!e.metaKey
    ) {
      try {
        onMatchFn && onMatchFn(r.combo);
      } catch (err) {
        console.warn("[hotkeys] onMatch threw:", err && err.message);
      }
      return;
    }
  }
}

function start({ onMatch }) {
  onMatchFn = typeof onMatch === "function" ? onMatch : null;
  if (!uIOhook) return false;
  if (started) return true;
  uIOhook.on("keydown", handleKeydown);
  try {
    uIOhook.start();
    started = true;
    return true;
  } catch (e) {
    console.warn("[hotkeys] failed to start uiohook:", e && e.message);
    return false;
  }
}

function stop() {
  if (!uIOhook || !started) return;
  try {
    uIOhook.stop();
  } catch {}
  uIOhook.removeAllListeners("keydown");
  started = false;
}

module.exports = { start, stop, setCombos, validateCombo };
