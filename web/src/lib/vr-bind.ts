// Valve Index controller bind model + matching engine.
//
// A bind is an ordered list of *steps*; each step is a set of *actions* that
// must be satisfied simultaneously. An action is one input + one edge (down or
// up). The sound fires when the LAST step completes — so a bind ending on an
// `up` fires on release, and a single simultaneous step is the classic
// "hold-these-together" chord.
//
// Two modes (a per-bind UI toggle, but the engine treats them uniformly — simul
// is just a one-step bind):
//   - simul: exactly one step (hold a group together / fire on a release edge)
//   - seq:   multiple steps performed in order (a combo / gesture)
//
// Matching semantics (see `advance`):
//   - down action = state-based: satisfied while the input is currently held.
//   - up   action = event-based: satisfied once its release edge fires during
//                   the active step.
//   - steps must advance within STEP_TIMEOUT_MS of the last progress or the bind
//     resets; inputs that aren't part of the pending step are ignored (they
//     don't reset progress).
//   - among binds completing on the SAME edge, the most-specific (most total
//     actions) wins.
//
// Stored in boardEntry.controllerBind as JSON (a leading "{"); legacy
// "+"-joined chord strings (VR:LeftHand:A+VR:RightHand:Trigger) are read as a
// single simultaneous step of down actions, so old binds keep working.

export type VrEdge = "down" | "up";
export type VrAction = { input: string; edge: VrEdge };
export type VrStep = VrAction[]; // simultaneous group
export type VrBindMode = "simul" | "seq";
export type VrBind = { mode: VrBindMode; steps: VrStep[] };

export const VR_HANDS = ["LeftHand", "RightHand"] as const;
export type VrHand = (typeof VR_HANDS)[number];

// Controller profile. Index and Quest/Touch expose DIFFERENT physical inputs and
// live in SEPARATE token namespaces ("VR:" vs "VRQ:"), so a bind built for one
// controller never fires on the other (locked owner decision). Index keeps the
// original "VR:" namespace so previously-stored binds keep working untouched.
export type VrProfile = "index" | "quest";
export const VR_PROFILES: { value: VrProfile; label: string }[] = [
  { value: "index", label: "Valve Index" },
  { value: "quest", label: "Quest / Touch" },
];
const PREFIX: Record<VrProfile, string> = { index: "VR", quest: "VRQ" };

// Per-profile input keys, by hand. These mirror the native bridge's action table
// (electron/native/vr-bridge/src/main.cpp) — keep them in sync. Index is
// symmetric; Quest/Touch is asymmetric (left = X/Y + Menu, right = A/B), has no
// trackpad/analog-pull, and adds a thumbrest touch + face/trigger touches.
const INDEX_KEYS = ["A", "B", "Trigger", "TriggerPull", "Grip", "ThumbstickClick", "ATouch", "TrackpadTouch"];
const QUEST_LEFT_KEYS = ["X", "XTouch", "Y", "YTouch", "Trigger", "TriggerTouch", "Grip", "ThumbstickClick", "ThumbstickTouch", "ThumbrestTouch", "Menu"];
const QUEST_RIGHT_KEYS = ["A", "ATouch", "B", "BTouch", "Trigger", "TriggerTouch", "Grip", "ThumbstickClick", "ThumbstickTouch", "ThumbrestTouch"];

function keysFor(profile: VrProfile, hand: VrHand): string[] {
  if (profile === "index") return INDEX_KEYS;
  return hand === "LeftHand" ? QUEST_LEFT_KEYS : QUEST_RIGHT_KEYS;
}

export function vrToken(profile: VrProfile, hand: VrHand, key: string): string {
  return `${PREFIX[profile]}:${hand}:${key}`;
}

// Input tokens grouped by hand for the given profile, in palette order.
export function vrInputsByHand(
  profile: VrProfile,
): { hand: VrHand; label: string; inputs: string[] }[] {
  return [
    { hand: "LeftHand", label: "Left hand", inputs: keysFor(profile, "LeftHand").map((k) => vrToken(profile, "LeftHand", k)) },
    { hand: "RightHand", label: "Right hand", inputs: keysFor(profile, "RightHand").map((k) => vrToken(profile, "RightHand", k)) },
  ];
}

// Display label per raw key. The token's key is unambiguous across profiles, so
// the profile isn't needed to render a label (a stored Quest bind shows Quest
// labels even if the device's current profile is Index).
const KEY_LABELS: Record<string, string> = {
  A: "A",
  B: "B",
  X: "X",
  Y: "Y",
  Trigger: "Trigger",
  TriggerPull: "Trigger pull",
  TriggerTouch: "Trigger touch",
  Grip: "Grip",
  ThumbstickClick: "Thumbstick",
  ThumbstickTouch: "Thumbstick touch",
  ATouch: "A touch",
  BTouch: "B touch",
  XTouch: "X touch",
  YTouch: "Y touch",
  TrackpadTouch: "Trackpad touch",
  ThumbrestTouch: "Thumbrest touch",
  Menu: "Menu",
};

// "VRQ:LeftHand:X" -> { hand: "L", key: "X" }. Accepts both namespaces.
export function parseToken(token: string): { hand: "L" | "R"; key: string } | null {
  const m = /^VRQ?:(LeftHand|RightHand):(.+)$/.exec(token);
  if (!m) return null;
  return { hand: m[1] === "LeftHand" ? "L" : "R", key: KEY_LABELS[m[2]] ?? m[2] };
}

// "VR:RightHand:A" + "down" -> "R A ↓".
export function formatVrAction(a: VrAction): string {
  const p = parseToken(a.input);
  const base = p ? `${p.hand} ${p.key}` : a.input;
  return `${base} ${a.edge === "down" ? "↓" : "↑"}`;
}

// --- serialization ----------------------------------------------------------

type RawAction = { i: unknown; e: unknown };

export function serializeVrBind(bind: VrBind): string {
  return JSON.stringify({
    v: 1,
    mode: bind.mode === "seq" ? "seq" : "simul",
    steps: bind.steps.map((s) => s.map((a) => ({ i: a.input, e: a.edge }))),
  });
}

// Tolerant parser: accepts the JSON format or a legacy "+"-joined chord string.
// Returns null for anything malformed/empty.
export function parseVrBind(value: string | null | undefined): VrBind | null {
  if (!value) return null;
  const t = value.trim();
  if (!t) return null;

  if (t.startsWith("{")) {
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      return null;
    }
    if (!o || typeof o !== "object") return null;
    const obj = o as { mode?: unknown; steps?: unknown };
    const mode: VrBindMode = obj.mode === "seq" ? "seq" : "simul";
    if (!Array.isArray(obj.steps)) return null;
    const steps: VrStep[] = [];
    for (const rawStep of obj.steps) {
      if (!Array.isArray(rawStep)) return null;
      const step: VrStep = [];
      for (const ra of rawStep as RawAction[]) {
        if (!ra || typeof ra.i !== "string") return null;
        const edge: VrEdge = ra.e === "up" ? "up" : "down";
        if (!step.some((x) => x.input === ra.i && x.edge === edge)) {
          step.push({ input: ra.i, edge });
        }
      }
      if (step.length) steps.push(step);
    }
    if (!steps.length) return null;
    return { mode, steps };
  }

  // Legacy chord: one simultaneous step of down actions.
  const inputs = t
    .split("+")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!inputs.length) return null;
  const seen = new Set<string>();
  const step: VrStep = [];
  for (const i of inputs) {
    if (!seen.has(i)) {
      seen.add(i);
      step.push({ input: i, edge: "down" });
    }
  }
  return { mode: "simul", steps: [step] };
}

// Total action count — drives "most-specific wins".
export function bindWeight(bind: VrBind): number {
  return bind.steps.reduce((n, s) => n + s.length, 0);
}

// Validation caps (shared with lib/validation.ts via isValidVrBindString).
export const MAX_STEPS = 8;
export const MAX_ACTIONS_PER_STEP = 4;
export const MAX_TOTAL_ACTIONS = 16;
// Union of every valid token across both profiles.
const VALID_INPUTS = new Set<string>(
  (["index", "quest"] as VrProfile[]).flatMap((p) =>
    VR_HANDS.flatMap((h) => keysFor(p, h).map((k) => vrToken(p, h, k))),
  ),
);

// Server-side guard: is this a well-formed single bind string (JSON or legacy)?
export function isValidVrBindString(value: string): boolean {
  const bind = parseVrBind(value);
  if (!bind) return false;
  if (bind.steps.length > MAX_STEPS) return false;
  let total = 0;
  for (const step of bind.steps) {
    if (step.length === 0 || step.length > MAX_ACTIONS_PER_STEP) return false;
    for (const a of step) {
      if (!VALID_INPUTS.has(a.input)) return false;
      total++;
    }
  }
  return total > 0 && total <= MAX_TOTAL_ACTIONS;
}

// --- per-profile binds -------------------------------------------------------
// A board entry (and cancel-all) keeps a SEPARATE controller bind per profile, so
// switching Index↔Quest swaps which bind is shown/edited/active — the other one
// is preserved untouched. On disk a `controllerBind` is either a profile map
// {"index":"<serialized>","quest":"<serialized>"} (each key optional) or, for
// binds saved before profiles existed, a bare serialized bind = the Index one.

export type ProfileBinds = Partial<Record<VrProfile, string>>;

// A serialized VrBind also starts with "{" — distinguish a profile map by its
// index/quest keys and the absence of a bind's "steps" key.
function isProfileMap(o: unknown): o is Record<string, unknown> {
  return (
    !!o &&
    typeof o === "object" &&
    !Array.isArray(o) &&
    !("steps" in o) &&
    ("index" in o || "quest" in o)
  );
}

export function parseProfileBinds(value: string | null | undefined): ProfileBinds {
  const t = value?.trim();
  if (!t) return {};
  if (t.startsWith("{")) {
    try {
      const o: unknown = JSON.parse(t);
      if (isProfileMap(o)) {
        const out: ProfileBinds = {};
        for (const p of ["index", "quest"] as VrProfile[]) {
          const v = (o as Record<string, unknown>)[p];
          if (typeof v === "string" && v) out[p] = v;
        }
        return out;
      }
    } catch {
      /* fall through — treat as a single (legacy) bind */
    }
  }
  return { index: t }; // legacy bare bind → the Index profile
}

// The serialized bind for one profile, or null.
export function getProfileBind(value: string | null | undefined, profile: VrProfile): string | null {
  return parseProfileBinds(value)[profile] ?? null;
}

// Merge `bind` (or clear with null) into `value` for `profile`; returns the
// serialized map to store, or null when no profile has a bind left.
export function setProfileBind(
  value: string | null | undefined,
  profile: VrProfile,
  bind: string | null,
): string | null {
  const map = parseProfileBinds(value);
  if (bind) map[profile] = bind;
  else delete map[profile];
  if (!map.index && !map.quest) return null;
  return JSON.stringify(map);
}

// Server-side guard for a stored `controllerBind`: a single bind (legacy) or a
// profile map whose every present value is itself a valid bind.
export function isValidControllerBindString(value: string): boolean {
  const t = value.trim();
  if (t.startsWith("{")) {
    try {
      const o: unknown = JSON.parse(t);
      if (isProfileMap(o)) {
        const vals = (["index", "quest"] as VrProfile[])
          .map((p) => (o as Record<string, unknown>)[p])
          .filter((v): v is string => typeof v === "string" && v.length > 0);
        return vals.length > 0 && vals.every(isValidVrBindString);
      }
    } catch {
      return false;
    }
  }
  return isValidVrBindString(value);
}

// --- matching engine --------------------------------------------------------

export const STEP_TIMEOUT_MS = 1500;

type MatchState = {
  stepIdx: number;
  satisfiedUp: Set<string>; // up-actions latched in the current step (key = input)
  lastProgress: number;
};

function freshState(): MatchState {
  return { stepIdx: 0, satisfiedUp: new Set(), lastProgress: 0 };
}

// Is (input, edge) one of the current step's still-pending actions?
function edgeMatchesPending(step: VrStep, satisfiedUp: Set<string>, input: string, edge: VrEdge): boolean {
  for (const a of step) {
    if (a.input !== input || a.edge !== edge) continue;
    // A down edge always re-confirms (the bridge emits one down per press). An
    // up edge is pending only until it's been latched for this step.
    return edge === "down" ? true : !satisfiedUp.has(input);
  }
  return false;
}

function stepComplete(step: VrStep, held: Set<string>, satisfiedUp: Set<string>): boolean {
  return step.every((a) => (a.edge === "down" ? held.has(a.input) : satisfiedUp.has(a.input)));
}

// Advance one bind's state for an incoming edge. Returns true iff the bind's
// final step just completed (i.e. fire the sound). `held` is the engine's global
// held set, already updated for this edge.
function advance(
  bind: VrBind,
  st: MatchState,
  held: Set<string>,
  input: string,
  edge: VrEdge,
  now: number
): boolean {
  const inProgress = st.stepIdx > 0 || st.satisfiedUp.size > 0;
  if (inProgress && now - st.lastProgress > STEP_TIMEOUT_MS) {
    st.stepIdx = 0;
    st.satisfiedUp.clear();
  }
  const step = bind.steps[st.stepIdx];
  if (!edgeMatchesPending(step, st.satisfiedUp, input, edge)) return false;

  if (edge === "up") st.satisfiedUp.add(input);
  st.lastProgress = now;

  if (stepComplete(step, held, st.satisfiedUp)) {
    if (st.stepIdx >= bind.steps.length - 1) {
      st.stepIdx = 0;
      st.satisfiedUp.clear();
      return true;
    }
    st.stepIdx += 1;
    st.satisfiedUp.clear();
    st.lastProgress = now;
  }
  return false;
}

// Stateful matcher: one per device. Feed it controller edges; it returns the id
// of the bind to fire (most-specific among same-edge completions) or null.
export class VrMatcher {
  private held = new Set<string>();
  private states = new Map<string, MatchState>();
  private binds: { id: string; bind: VrBind; weight: number }[] = [];

  // Reconcile the active bind set (drops state for removed ids, seeds new ones).
  setBinds(binds: { id: string; bind: VrBind }[]): void {
    this.binds = binds.map((b) => ({ id: b.id, bind: b.bind, weight: bindWeight(b.bind) }));
    const ids = new Set(this.binds.map((b) => b.id));
    for (const k of [...this.states.keys()]) if (!ids.has(k)) this.states.delete(k);
    for (const b of this.binds) if (!this.states.has(b.id)) this.states.set(b.id, freshState());
  }

  feed(input: string, edge: VrEdge, now: number): string | null {
    if (edge === "down") this.held.add(input);
    else this.held.delete(input);

    let best: { id: string; weight: number } | null = null;
    for (const b of this.binds) {
      const st = this.states.get(b.id);
      if (!st) continue;
      if (advance(b.bind, st, this.held, input, edge, now)) {
        if (!best || b.weight > best.weight) best = { id: b.id, weight: b.weight };
      }
    }
    return best ? best.id : null;
  }

  // Drop held + in-progress state (e.g. when the bind editor opens/closes, so
  // physical presses made in the editor don't leak into playback matching).
  reset(): void {
    this.held.clear();
    for (const s of this.states.values()) {
      s.stepIdx = 0;
      s.satisfiedUp.clear();
    }
  }
}

// --- single-bind preview (the editor's test area) ---------------------------
// A tiny one-bind tracker that reports progress for the live test/preview area.

export type VrPreviewProgress = {
  stepIdx: number; // current step being matched
  satisfied: boolean[][]; // per step, per action: satisfied right now
  justFired: boolean;
};

export class VrBindPreview {
  private st = freshState();
  private held = new Set<string>();

  constructor(private bind: VrBind) {}

  setBind(bind: VrBind): void {
    this.bind = bind;
    this.st = freshState();
  }

  feed(input: string, edge: VrEdge, now: number): VrPreviewProgress {
    if (edge === "down") this.held.add(input);
    else this.held.delete(input);
    const fired = this.bind.steps.length ? advance(this.bind, this.st, this.held, input, edge, now) : false;
    return this.snapshot(fired);
  }

  snapshot(justFired = false): VrPreviewProgress {
    const satisfied = this.bind.steps.map((step, si) =>
      step.map((a) => {
        if (si < this.st.stepIdx) return true; // already-passed steps
        if (si > this.st.stepIdx) return false; // not reached yet
        return a.edge === "down" ? this.held.has(a.input) : this.st.satisfiedUp.has(a.input);
      })
    );
    return { stepIdx: this.st.stepIdx, satisfied, justFired };
  }
}
