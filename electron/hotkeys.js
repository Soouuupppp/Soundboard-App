// Passthrough global hotkeys backed by uiohook-napi.
//
// Unlike Electron's built-in `globalShortcut` (which uses RegisterHotKey /
// CGEventTap in "swallow" mode and *blocks* the key from reaching other apps),
// uiohook is a low-level keyboard listener — it only *observes*. The key still
// fires in whatever app currently has focus.
//
// Public API:
//   start({ onMatch, onMatchUp }) — begin listening; onMatch(combo) fires when a
//                        combo completes (down edge), onMatchUp(combo) when the
//                        key that completed it releases (up edge). The up edge lets
//                        the renderer implement hold-to-X (e.g. AI push-to-talk:
//                        record while held, convert on release) for unfocused keys.
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

// Keycodes for the modifier keys themselves. We never treat these as "main"
// keys — modifier state comes from the event flags (ctrlKey, etc.) — so a
// modifier keydown shouldn't complete a chord on its own.
const MODIFIER_KEYCODES = new Set();
if (UiohookKey) {
  for (const n of ["Ctrl", "CtrlRight", "Alt", "AltRight", "Shift", "ShiftRight", "Meta", "MetaRight"]) {
    const c = UiohookKey[n];
    if (typeof c === "number") MODIFIER_KEYCODES.add(c);
  }
}

// Combo grammar now allows a *chord*: modifiers + one or more non-modifier keys
// held together, e.g. "Ctrl+Shift+F5", "A+B".
function parseCombo(combo) {
  if (typeof combo !== "string") return null;
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 6) return null;

  const mods = { ctrl: false, shift: false, alt: false, meta: false };
  const keycodes = [];
  const keyNames = [];

  for (const raw of parts) {
    const tok = raw.toUpperCase();
    if (MODIFIER_TOKENS.has(tok)) {
      if (tok === "CTRL") mods.ctrl = true;
      else if (tok === "SHIFT") mods.shift = true;
      else if (tok === "ALT") mods.alt = true;
      else if (tok === "META") mods.meta = true;
    } else {
      const code = KEY_MAP.get(tok);
      if (typeof code !== "number") return null;
      if (!keycodes.includes(code)) {
        keycodes.push(code);
        keyNames.push(tok);
      }
    }
  }
  if (keycodes.length === 0) return null; // need at least one non-modifier key
  return { mods, keycodes, keyNames };
}

function validateCombo(combo) {
  const p = parseCombo(combo);
  if (!p) return { ok: false, reason: "unrecognized key combination" };
  return { ok: true, parsed: p };
}

// --- Runtime state ---------------------------------------------------------

let started = false;
let registry = []; // [{ combo, mods, keys: Set<keycode> }]
let onMatchFn = null;
let onMatchUpFn = null;
const heldKeys = new Set(); // currently-held non-modifier keycodes
// Maps the keycode that *completed* an active combo → that combo, so we can fire
// the up edge when it releases. Keyed by completing key (one combo per key edge).
const activeByKey = new Map();

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
    registry.push({ combo, mods: v.parsed.mods, keys: new Set(v.parsed.keycodes) });
  }
}

// Fire on the key that *completes* a bound chord: all of the chord's keys held,
// modifier flags matching exactly, and the just-pressed key part of it. Among
// satisfied chords the largest (most keys) wins, so a chord suppresses its
// sub-binds when the extra keys are held first.
function handleKeydown(e) {
  if (MODIFIER_KEYCODES.has(e.keycode)) return; // modifiers come from flags
  if (heldKeys.has(e.keycode)) return; // auto-repeat
  heldKeys.add(e.keycode);
  if (registry.length === 0) return;

  let best = null;
  for (const r of registry) {
    if (r.mods.ctrl !== !!e.ctrlKey) continue;
    if (r.mods.shift !== !!e.shiftKey) continue;
    if (r.mods.alt !== !!e.altKey) continue;
    if (r.mods.meta !== !!e.metaKey) continue;
    if (!r.keys.has(e.keycode)) continue;
    let all = true;
    for (const k of r.keys) {
      if (!heldKeys.has(k)) {
        all = false;
        break;
      }
    }
    if (all && (!best || r.keys.size > best.keys.size)) best = r;
  }
  if (best) {
    // Remember the completing key so its release can fire the up edge. (If this
    // key already completed a combo and hasn't released, keep the first.)
    if (!activeByKey.has(e.keycode)) activeByKey.set(e.keycode, best.combo);
    try {
      onMatchFn && onMatchFn(best.combo);
    } catch (err) {
      console.warn("[hotkeys] onMatch threw:", err && err.message);
    }
  }
}

function handleKeyup(e) {
  heldKeys.delete(e.keycode);
  const combo = activeByKey.get(e.keycode);
  if (combo !== undefined) {
    activeByKey.delete(e.keycode);
    try {
      onMatchUpFn && onMatchUpFn(combo);
    } catch (err) {
      console.warn("[hotkeys] onMatchUp threw:", err && err.message);
    }
  }
}

function start({ onMatch, onMatchUp }) {
  onMatchFn = typeof onMatch === "function" ? onMatch : null;
  onMatchUpFn = typeof onMatchUp === "function" ? onMatchUp : null;
  if (!uIOhook) return false;
  if (started) return true;
  uIOhook.on("keydown", handleKeydown);
  uIOhook.on("keyup", handleKeyup);
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
  uIOhook.removeAllListeners("keyup");
  heldKeys.clear();
  activeByKey.clear();
  started = false;
}

module.exports = { start, stop, setCombos, validateCombo };
