// Chord helpers shared by the keyboard and controller bind paths.
//
// A bind is a *set* of inputs held simultaneously, serialized as a "+"-joined,
// canonically-ordered string. Two separate namespaces (never mixed):
//   - keyboard: "Ctrl+Shift+F5", "A+B"  (modifiers are matched strictly via
//     event flags; other keys use subset matching)
//   - controller: "VR:LeftHand:TrackpadTouch+VR:RightHand:A"
//
// Matching fires on the input that *completes* a bound set; among all satisfied
// binds, the largest (most inputs) wins — so a chord suppresses its sub-binds
// when the extra inputs are held first (the natural chord usage).

export type Mods = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

// --- Keyboard ---------------------------------------------------------------

export function isModToken(t: string): boolean {
  return t === "Ctrl" || t === "Alt" || t === "Shift" || t === "Meta";
}

// The token for a single physical key. Modifiers map to their token; everything
// else is normalized the way the old single-combo capture did.
export function keyTokenFromEvent(ev: KeyboardEvent): string | null {
  const k = ev.key;
  if (k === "Control") return "Ctrl";
  if (k === "Alt") return "Alt";
  if (k === "Shift") return "Shift";
  if (k === "Meta") return "Meta";
  if (k === " ") return "Space";
  if (!k) return null;
  return k.length === 1 ? k.toUpperCase() : k;
}

export function modsFromEvent(ev: KeyboardEvent): Mods {
  return { ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, meta: ev.metaKey };
}

export function sameMods(a: Mods, b: Mods): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;
}

export function parseKeyCombo(s: string): { mods: Mods; keys: string[] } {
  const mods: Mods = { ctrl: false, alt: false, shift: false, meta: false };
  const keys: string[] = [];
  for (const raw of s.split("+").map((t) => t.trim()).filter(Boolean)) {
    if (raw === "Ctrl") mods.ctrl = true;
    else if (raw === "Alt") mods.alt = true;
    else if (raw === "Shift") mods.shift = true;
    else if (raw === "Meta") mods.meta = true;
    else keys.push(raw.length === 1 ? raw.toUpperCase() : raw);
  }
  return { mods, keys };
}

// Canonical order: modifiers (fixed order) then non-modifier keys sorted. Keeps
// existing single-key/modifier combos byte-identical, so stored binds still work.
export function canonicalKeyCombo(mods: Mods, keys: string[]): string {
  const parts: string[] = [];
  if (mods.ctrl) parts.push("Ctrl");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  if (mods.meta) parts.push("Meta");
  parts.push(...[...new Set(keys)].sort());
  return parts.join("+");
}

// --- Controller -------------------------------------------------------------

export function parseVrChord(s: string): string[] {
  return s.split("+").map((t) => t.trim()).filter(Boolean);
}

export function canonicalVrChord(tokens: string[]): string {
  return [...new Set(tokens)].sort().join("+");
}

// --- Generic largest-wins selection -----------------------------------------
// Given the set of held tokens, the token that just went down, and a list of
// candidate binds (each a set of tokens that must all be held), return the
// largest bind that (a) contains the just-pressed token and (b) is fully held.

export function pickLargest<T extends { tokens: Set<string> }>(
  held: Set<string>,
  downToken: string,
  binds: T[]
): T | null {
  let best: T | null = null;
  for (const b of binds) {
    if (!b.tokens.has(downToken)) continue;
    let all = true;
    for (const t of b.tokens) {
      if (!held.has(t)) {
        all = false;
        break;
      }
    }
    if (all && (!best || b.tokens.size > best.tokens.size)) best = b;
  }
  return best;
}
