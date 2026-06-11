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

// The 16 physical inputs, mirrored from the native bridge's makeDigital() +
// makeAnalog() (electron/native/vr-bridge/src/main.cpp). Touch + analog
// trigger-pull are first-class, bindable inputs (locked owner decision).
export const VR_INPUT_KEYS = [
  "A",
  "B",
  "Trigger",
  "TriggerPull",
  "Grip",
  "ThumbstickClick",
  "ATouch",
  "TrackpadTouch",
] as const;
export type VrInputKey = (typeof VR_INPUT_KEYS)[number];

export const VR_HANDS = ["LeftHand", "RightHand"] as const;
export type VrHand = (typeof VR_HANDS)[number];

export function vrToken(hand: VrHand, key: VrInputKey): string {
  return `VR:${hand}:${key}`;
}

// All 16 input tokens, grouped by hand, in palette order.
export const VR_INPUTS_BY_HAND: { hand: VrHand; label: string; inputs: string[] }[] = [
  { hand: "LeftHand", label: "Left hand", inputs: VR_INPUT_KEYS.map((k) => vrToken("LeftHand", k)) },
  { hand: "RightHand", label: "Right hand", inputs: VR_INPUT_KEYS.map((k) => vrToken("RightHand", k)) },
];

// "VR:RightHand:TriggerPull" -> { hand: "R", key: "Trigger pull" }
const KEY_LABELS: Record<string, string> = {
  A: "A",
  B: "B",
  Trigger: "Trigger",
  TriggerPull: "Trigger pull",
  Grip: "Grip",
  ThumbstickClick: "Thumbstick",
  ATouch: "A touch",
  TrackpadTouch: "Trackpad touch",
};

export function parseToken(token: string): { hand: "L" | "R"; key: string } | null {
  const m = /^VR:(LeftHand|RightHand):(.+)$/.exec(token);
  if (!m) return null;
  return { hand: m[1] === "LeftHand" ? "L" : "R", key: KEY_LABELS[m[2]] ?? m[2] };
}

// "VR:RightHand:A" + "down" -> "R A ↓"
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
const VALID_INPUTS = new Set(
  VR_HANDS.flatMap((h) => VR_INPUT_KEYS.map((k) => vrToken(h, k)))
);

// Server-side guard: is this a well-formed bind string (new JSON or legacy)?
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
