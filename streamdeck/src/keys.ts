// Generated SVG key images. Sound and profile names come from the (remote, semi-
// trusted) web app, so every string is XML-escaped before it goes into the markup.

export type Glyph = "play" | "stop" | "mic" | "replay" | "capture" | "capturePlay" | "profile" | "sparkle";

export type KeyLook = {
  glyph: Glyph;
  /** Drawn under the glyph; omitted when the user typed their own title. */
  label?: string;
  /** Highlighted (playing, recording, active profile). */
  active?: boolean;
  /** The app isn't reachable or the dashboard isn't open. */
  offline?: boolean;
  /** Highlight colour for this action. */
  accent?: string;
};

const SIZE = 144;
const BG = "#14161f";
const FG = "#e6e8ee";
const DIM = "#5b6070";

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

// Glyphs drawn in a 48×48 box, then scaled into place.
const GLYPHS: Record<Glyph, (c: string) => string> = {
  play: (c) => `<path d="M14 8 L40 24 L14 40 Z" fill="${c}"/>`,
  stop: (c) => `<rect x="10" y="10" width="28" height="28" rx="4" fill="${c}"/>`,
  mic: (c) =>
    `<rect x="17" y="4" width="14" height="24" rx="7" fill="${c}"/>` +
    `<path d="M10 22 a14 14 0 0 0 28 0" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="M24 36 V44 M16 44 H32" stroke="${c}" stroke-width="4" stroke-linecap="round"/>`,
  replay: (c) =>
    `<path d="M38 24 a14 14 0 1 1 -4.1 -9.9" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round"/>` +
    `<path d="M36 6 V16 H26" fill="none" stroke="${c}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
  capture: (c) =>
    `<circle cx="24" cy="24" r="17" fill="none" stroke="${c}" stroke-width="4"/>` +
    `<circle cx="24" cy="24" r="9" fill="${c}"/>`,
  // Livepad capture ring with a play triangle inside: plays a capture.
  capturePlay: (c) =>
    `<circle cx="24" cy="24" r="19" fill="none" stroke="${c}" stroke-width="4"/>` +
    `<path d="M19 14 L34 24 L19 34 Z" fill="${c}"/>`,
  // Four-point star: AI voice on/off.
  sparkle: (c) =>
    `<path d="M24 4 C26 16 32 22 44 24 C32 26 26 32 24 44 C22 32 16 26 4 24 C16 22 22 16 24 4 Z" fill="${c}"/>`,
  profile: (c) =>
    `<circle cx="24" cy="15" r="9" fill="${c}"/>` +
    `<path d="M8 42 a16 14 0 0 1 32 0 Z" fill="${c}"/>`,
};

// Up to three lines of about 12 characters, breaking on spaces where possible.
function wrap(text: string, width = 12, maxLines = 3): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  const push = (l: string) => lines.push(l);
  for (let w of words) {
    while (w.length > width) {
      if (cur) {
        push(cur);
        cur = "";
      }
      push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += " " + w;
    else {
      push(cur);
      cur = w;
    }
  }
  if (cur) push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].slice(0, width - 1) + "…";
    return kept;
  }
  return lines;
}

export function renderKey(look: KeyLook): string {
  const accent = look.accent ?? "#5865F2";
  const bg = look.active ? accent : BG;
  const fg = look.offline ? DIM : FG;
  const lines = look.label ? wrap(look.label) : [];

  // Glyph centered when alone, pushed up when a label is drawn below it.
  const glyphSize = lines.length ? 44 : 72;
  const gx = (SIZE - glyphSize) / 2;
  const gy = lines.length ? 14 : (SIZE - glyphSize) / 2;
  const scale = glyphSize / 48;

  const lineHeight = 22;
  const textTop = 68 + lineHeight; // baselines 90, 112, 134
  const text = lines
    .map(
      (l, i) =>
        `<text x="${SIZE / 2}" y="${textTop + i * lineHeight}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="19" font-weight="600" fill="${fg}">${escapeXml(l)}</text>`,
    )
    .join("");

  // Offline: dimmed glyph + a small slashed-circle badge in the corner.
  const badge = look.offline
    ? `<g transform="translate(112 8)"><circle cx="12" cy="12" r="10" fill="none" stroke="#e5484d" stroke-width="3"/><path d="M5 19 L19 5" stroke="#e5484d" stroke-width="3"/></g>`
    : "";

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>` +
    `<g transform="translate(${gx} ${gy}) scale(${scale})">${GLYPHS[look.glyph](fg)}</g>` +
    text +
    badge +
    `</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}
