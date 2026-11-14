"use client";

// Editor for the VRChat avatar panel (desktop app only, 1.5.2 experimental). Opened
// from the navbar. A Stream-Deck-like grid: drag an action from the palette onto a
// key (or click the action, then the key), drag keys to move/swap them, drag a key
// back to the palette to clear it. The selected key's options sit below the grid.
//
// The layout belongs to the active profile and saves on every change (debounced
// server PATCH in ProfileProvider). Slots live in a fixed 3×5 space, so a smaller
// grid only grays the outer slots out; they keep their settings.

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useOscLayout, useProfiles } from "@/components/ProfileProvider";
import { useLivepad } from "@/components/LivepadProvider";
import { useToast } from "@/components/Toast";
import { Select, type SelectOption } from "@/components/Select";
import { Toggle } from "@/components/Toggle";
import { useVrcOscEnabled } from "@/components/VrcOscBridge";
import {
  ACTION_LABELS,
  GRID_SIZES,
  MAX_PAGES,
  MAX_POSITION,
  SLOT_COLS,
  SLOT_COUNT,
  emptyPage,
  getVrcOscBridge,
  gridForKeys,
  keysFor,
  newAction,
  slotInGrid,
  writeVrcOscEnabled,
  type GridSize,
  type OscActionType,
  type OscKeyAction,
  type OscLayout,
  type VrcOscConfig,
  type VrcOscStatus,
} from "@/lib/osc-board";

const PALETTE: OscActionType[] = ["play", "cancelAll", "livepadCapture", "livepadPlay", "profile", "pagePrev", "pageNext"];
const DRAG_MIME = "application/x-soundboard-osc";
const GRID_LABEL: Record<GridSize, string> = { "1x5": "1 × 5 (5 keys)", "3x3": "3 × 3 (9 keys)", "3x5": "3 × 5 (15 keys)" };

type Drag = { from: "palette"; type: OscActionType } | { from: "slot"; slot: number };
type SavedSound = { soundId: string; name: string; onBoard: boolean };

export function OscBoardEditor() {
  const { oscLayout: layout, setOscLayout } = useOscLayout();
  const { profiles, activeProfileId } = useProfiles();
  const { captures } = useLivepad();
  const toast = useToast();
  const enabled = useVrcOscEnabled();

  const [pageIdx, setPageIdx] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [placing, setPlacing] = useState<OscActionType | null>(null);
  const [sounds, setSounds] = useState<SavedSound[] | null>(null);
  const page = Math.min(pageIdx, layout.pages.length - 1);

  // Saved sounds of the active profile (for the sound picker + "(gone)" checks).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/board${activeProfileId ? `?profileId=${encodeURIComponent(activeProfileId)}` : ""}`);
        if (!r.ok) {
          if (!cancelled) toast.fromResponse(r, "Couldn't load your sounds");
          return;
        }
        const data = await r.json();
        const seen = new Set<string>();
        const list: SavedSound[] = [];
        for (const e of data.entries ?? []) {
          const id = e?.sound?.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          list.push({ soundId: id, name: e?.entry?.label || e?.sound?.name || "Untitled", onBoard: !!e?.entry?.onBoard });
        }
        if (!cancelled) setSounds(list);
      } catch {
        if (!cancelled) toast.error("Couldn't load your sounds");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProfileId, toast]);

  // A failed debounced save is reported by ProfileProvider through this event.
  useEffect(() => {
    const h = () => toast.error("Couldn't save the avatar panel layout");
    window.addEventListener("soundboard:oscLayout-saveFailed", h);
    return () => window.removeEventListener("soundboard:oscLayout-saveFailed", h);
  }, [toast]);

  const commit = (next: OscLayout) => setOscLayout(next);
  const setSlot = (slot: number, action: OscKeyAction | null, other?: { slot: number; action: OscKeyAction | null }) => {
    const pages = layout.pages.slice();
    const p = pages[page].slice();
    p[slot] = action;
    if (other) p[other.slot] = other.action;
    pages[page] = p;
    commit({ ...layout, pages });
  };

  const onDropSlot = (slot: number, d: Drag) => {
    if (!slotInGrid(layout.grid, slot)) return;
    if (d.from === "palette") {
      setSlot(slot, newAction(d.type));
    } else if (d.slot !== slot) {
      const cur = layout.pages[page];
      setSlot(slot, cur[d.slot], { slot: d.slot, action: cur[slot] }); // swap (or move into an empty key)
    }
    setSelected(slot);
  };

  const onClickSlot = (slot: number) => {
    if (placing && slotInGrid(layout.grid, slot)) {
      setSlot(slot, newAction(placing));
      setPlacing(null);
    }
    setSelected(slot);
  };

  const addPage = () => {
    if (layout.pages.length >= MAX_PAGES) return;
    commit({ ...layout, pages: [...layout.pages, emptyPage()] });
    setPageIdx(layout.pages.length);
    setSelected(null);
  };
  const removePage = (i: number) => {
    if (layout.pages.length < 2) return;
    if (layout.pages[i].some(Boolean) && !confirm(`Remove page ${i + 1} and its keys?`)) return;
    commit({ ...layout, pages: layout.pages.filter((_, j) => j !== i) });
    setPageIdx(Math.max(0, Math.min(page, layout.pages.length - 2)));
    setSelected(null);
  };

  const soundIds = useMemo(() => new Set((sounds ?? []).map((s) => s.soundId)), [sounds]);
  const keyTitle = (a: OscKeyAction): { label: string; detail?: string; gone?: boolean } => {
    switch (a.type) {
      case "play": {
        if (!a.soundId) return { label: "Play", detail: "Pick a sound" };
        const s = sounds?.find((x) => x.soundId === a.soundId);
        return { label: "Play", detail: s?.name ?? a.soundName, gone: sounds !== null && !soundIds.has(a.soundId) };
      }
      case "livepadPlay":
        if (a.mode === "position") return { label: "Livepad", detail: `#${a.slot}` };
        if (!a.captureId) return { label: "Livepad", detail: "Pick a capture" };
        return { label: "Livepad", detail: a.captureName, gone: !captures.some((c) => c.id === a.captureId) };
      case "profile":
        if (a.mode === "cycle") return { label: "Profile", detail: "Cycle" };
        if (!a.profileId) return { label: "Profile", detail: "Pick a profile" };
        return {
          label: "Profile",
          detail: profiles.find((p) => p.id === a.profileId)?.name ?? a.profileName,
          gone: !profiles.some((p) => p.id === a.profileId),
        };
      default:
        return { label: ACTION_LABELS[a.type] };
    }
  };

  const sel = selected === null ? null : layout.pages[page][selected];

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold">VRChat avatar panel</div>
        <label className="flex items-center gap-2 text-xs text-muted">
          On
          <Toggle size="sm" checked={enabled} onChange={writeVrcOscEnabled} label="Avatar panel on" />
        </label>
      </div>

      <OscStatusLine enabled={enabled} grid={layout.grid} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Grid</span>
        <Select
          value={layout.grid}
          onChange={(g) => commit({ ...layout, grid: g as GridSize })}
          options={GRID_SIZES.map((g) => ({ value: g, label: GRID_LABEL[g] }))}
          className="w-44"
          aria-label="Grid size"
        />
      </div>

      {/* Page tabs */}
      <div className="flex flex-wrap items-center gap-1">
        {layout.pages.map((_, i) => (
          <span key={i} className={`inline-flex items-center rounded-full border text-xs ${i === page ? "border-accent/40 bg-accent/15 text-white" : "border-white/10 bg-white/[0.04] text-muted"}`}>
            <button type="button" className="px-2.5 py-1" onClick={() => { setPageIdx(i); setSelected(null); }}>
              Page {i + 1}
            </button>
            {layout.pages.length > 1 && (
              <button type="button" className="pr-2 hover:text-white" title={`Remove page ${i + 1}`} aria-label={`Remove page ${i + 1}`} onClick={() => removePage(i)}>
                <X size={12} />
              </button>
            )}
          </span>
        ))}
        {layout.pages.length < MAX_PAGES && (
          <button type="button" onClick={addPage} className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-xs text-muted hover:text-white" title="Add page">
            <Plus size={12} /> Page
          </button>
        )}
      </div>

      {/* Palette (also a drop target: dropping a key here clears it) */}
      <div
        className="flex flex-wrap gap-1.5 rounded-lg border border-dashed border-white/10 p-2"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const d = readDrag(e);
          if (d?.from === "slot") {
            setSlot(d.slot, null);
            setSelected(null);
          }
        }}
      >
        {PALETTE.map((t) => (
          <button
            key={t}
            type="button"
            draggable
            onDragStart={(e) => writeDrag(e, { from: "palette", type: t })}
            onClick={() => setPlacing((cur) => (cur === t ? null : t))}
            className={`rounded-md border px-2 py-1 text-xs ${placing === t ? "border-accent/50 bg-accent/20 text-white" : "border-white/10 bg-white/[0.05] text-muted hover:text-white"}`}
          >
            {ACTION_LABELS[t]}
          </button>
        ))}
      </div>
      {placing && <div className="text-xs text-muted">Click a key to place “{ACTION_LABELS[placing]}”.</div>}

      {/* Grid: always the full 3×5 space, slots outside the current grid grayed. */}
      <div className="rounded-xl bg-black/40 p-3 border border-white/10">
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${SLOT_COLS}, minmax(0, 1fr))` }}>
          {Array.from({ length: SLOT_COUNT }, (_, slot) => {
            const a = layout.pages[page][slot];
            const inGrid = slotInGrid(layout.grid, slot);
            const t = a ? keyTitle(a) : null;
            return (
              <button
                key={slot}
                type="button"
                draggable={!!a}
                onDragStart={(e) => writeDrag(e, { from: "slot", slot })}
                onDragOver={(e) => inGrid && e.preventDefault()}
                onDrop={(e) => {
                  const d = readDrag(e);
                  if (d) onDropSlot(slot, d);
                }}
                onClick={() => onClickSlot(slot)}
                title={inGrid ? undefined : "Outside the current grid size (kept, inactive)"}
                className={`aspect-square rounded-lg border p-1 text-[11px] leading-tight flex flex-col items-center justify-center text-center overflow-hidden ${
                  selected === slot ? "border-accent ring-1 ring-accent/50" : "border-white/10"
                } ${inGrid ? "bg-white/[0.06] hover:bg-white/[0.1]" : "bg-white/[0.02] opacity-35"} ${t?.gone ? "text-amber-300" : ""}`}
              >
                {t ? (
                  <>
                    <span className="font-semibold">{t.label}</span>
                    {t.detail && <span className="text-muted break-words line-clamp-2">{t.gone ? `${t.detail} (gone)` : t.detail}</span>}
                  </>
                ) : (
                  <span className="text-white/20">{inGrid ? "+" : ""}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected key options */}
      {selected !== null && sel && (
        <KeyOptions
          action={sel}
          inGrid={slotInGrid(layout.grid, selected)}
          sounds={sounds}
          captures={captures}
          profiles={profiles}
          onChange={(a) => setSlot(selected, a)}
          onRemove={() => {
            setSlot(selected, null);
            setSelected(null);
          }}
        />
      )}

      <ManualPorts />
    </div>
  );
}

function writeDrag(e: DragEvent, d: Drag) {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(d));
  e.dataTransfer.effectAllowed = "move";
}

function readDrag(e: DragEvent): Drag | null {
  e.preventDefault();
  try {
    const d = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as Drag;
    if (d?.from === "palette" && PALETTE.includes(d.type)) return d;
    if (d?.from === "slot" && Number.isInteger(d.slot) && d.slot >= 0 && d.slot < SLOT_COUNT) return d;
  } catch {}
  return null;
}

function KeyOptions({
  action: a,
  inGrid,
  sounds,
  captures,
  profiles,
  onChange,
  onRemove,
}: {
  action: OscKeyAction;
  inGrid: boolean;
  sounds: SavedSound[] | null;
  captures: { id: string; name: string; durationSec: number }[];
  profiles: { id: string; name: string; position: number }[];
  onChange: (a: OscKeyAction) => void;
  onRemove: () => void;
}) {
  let body: ReactNode = null;
  if (a.type === "play") {
    const options: SelectOption[] = [];
    const list = sounds ?? [];
    for (const s of list.filter((x) => x.onBoard)) options.push({ value: s.soundId, label: s.name, group: "On board" });
    for (const s of list.filter((x) => !x.onBoard).sort((x, y) => x.name.localeCompare(y.name))) {
      options.push({ value: s.soundId, label: s.name, group: "Saved" });
    }
    if (a.soundId && sounds && !list.some((s) => s.soundId === a.soundId)) {
      options.push({ value: a.soundId, label: `${a.soundName} (gone)`, group: "Not in Saved" });
    }
    body = (
      <Select
        value={a.soundId}
        onChange={(id) => onChange({ type: "play", soundId: id, soundName: list.find((s) => s.soundId === id)?.name ?? a.soundName })}
        options={options}
        placeholder={sounds === null ? "Loading sounds…" : "Pick a sound"}
        className="w-full"
        aria-label="Sound"
      />
    );
  } else if (a.type === "livepadPlay") {
    const options: SelectOption[] = captures.map((c) => ({ value: c.id, label: `${c.name} (${Math.round(c.durationSec)}s)` }));
    if (a.mode === "specific" && a.captureId && !captures.some((c) => c.id === a.captureId)) {
      options.push({ value: a.captureId, label: `${a.captureName} (gone)` });
    }
    body = (
      <div className="space-y-2">
        <Select
          value={a.mode}
          onChange={(m) => onChange(m === "position" ? { type: "livepadPlay", mode: "position", slot: 1 } : { type: "livepadPlay", mode: "specific", captureId: "", captureName: "" })}
          options={[
            { value: "position", label: "Position (1 = newest)" },
            { value: "specific", label: "Specific capture" },
          ]}
          className="w-full"
          aria-label="Livepad mode"
        />
        {a.mode === "position" ? (
          <input
            type="number"
            min={1}
            max={MAX_POSITION}
            value={a.slot}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) onChange({ ...a, slot: Math.min(MAX_POSITION, Math.max(1, n)) });
            }}
            className="input w-24"
            aria-label="Position"
          />
        ) : (
          <Select
            value={a.captureId}
            onChange={(id) => onChange({ ...a, captureId: id, captureName: captures.find((c) => c.id === id)?.name ?? a.captureName })}
            options={options}
            placeholder={captures.length ? "Pick a capture" : "No captures yet"}
            className="w-full"
            aria-label="Capture"
          />
        )}
        <div className="text-xs text-muted">Captures are temporary: a specific capture is gone once deleted or when the app closes.</div>
      </div>
    );
  } else if (a.type === "profile") {
    const ordered = profiles.slice().sort((x, y) => x.position - y.position);
    const options: SelectOption[] = ordered.map((p) => ({ value: p.id, label: p.name }));
    if (a.mode === "specific" && a.profileId && !profiles.some((p) => p.id === a.profileId)) {
      options.push({ value: a.profileId, label: `${a.profileName} (gone)` });
    }
    body = (
      <div className="space-y-2">
        <Select
          value={a.mode}
          onChange={(m) => onChange(m === "cycle" ? { type: "profile", mode: "cycle" } : { type: "profile", mode: "specific", profileId: "", profileName: "" })}
          options={[
            { value: "cycle", label: "Cycle to next" },
            { value: "specific", label: "Specific profile" },
          ]}
          className="w-full"
          aria-label="Profile mode"
        />
        {a.mode === "specific" && (
          <Select
            value={a.profileId}
            onChange={(id) => onChange({ ...a, profileId: id, profileName: profiles.find((p) => p.id === id)?.name ?? a.profileName })}
            options={options}
            placeholder="Pick a profile"
            className="w-full"
            aria-label="Profile"
          />
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium">{ACTION_LABELS[a.type]}</span>
        <button type="button" onClick={onRemove} className="inline-flex items-center gap-1 text-xs text-muted hover:text-red-300" title="Clear this key">
          <Trash2 size={12} /> Clear
        </button>
      </div>
      {!inGrid && <div className="text-xs text-amber-300/90">This key is outside the current grid size, so it's inactive.</div>}
      {body}
    </div>
  );
}

// "VRChat not found" / "no Soundboard panel" / "N-key panel", plus a mismatch warning.
function OscStatusLine({ enabled, grid }: { enabled: boolean; grid: GridSize }) {
  const [status, setStatus] = useState<VrcOscStatus | null>(null);
  useEffect(() => {
    const bridge = getVrcOscBridge();
    if (!bridge) return;
    let alive = true;
    void bridge.getStatus().then((s) => alive && setStatus(s));
    const off = bridge.onStatus((s) => setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!enabled) {
    return (
      <div className="text-xs text-muted">
        Off on this device. Turn it on to connect to VRChat; Windows may ask once to allow the app through the firewall
        (private networks is enough).
      </div>
    );
  }
  if (!status?.running) {
    const err =
      status?.error === "port-in-use"
        ? "The receive port is already in use."
        : status?.error === "mdns-missing"
          ? "Discovery isn't available in this build. Use manual ports."
          : status?.error
            ? "Couldn't start OSC."
            : "Open the dashboard to connect.";
    return <div className="text-xs text-muted">{err}</div>;
  }
  if (!status.vrchatFound) {
    return <div className="text-xs text-muted">{status.manual ? "Waiting for VRChat on the manual ports…" : "VRChat not found."}</div>;
  }
  const avatarGrid = gridForKeys(status.avatarKeys);
  return (
    <div className="space-y-1">
      <div className="text-xs text-emerald-300/90">
        {status.avatarKeys === null
          ? "Connected to VRChat."
          : status.avatarKeys === 0
            ? "Connected — avatar has no Soundboard panel."
            : `Connected — ${status.avatarKeys}-key panel.`}
      </div>
      {avatarGrid && avatarGrid !== grid && (
        <div className="flex items-start gap-1.5 text-xs text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          The avatar has a {status.avatarKeys}-key panel but this layout is {keysFor(grid)} keys.
        </div>
      )}
    </div>
  );
}

function ManualPorts() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<VrcOscConfig | null>(null);
  const [inPort, setInPort] = useState("");
  const [outPort, setOutPort] = useState("");

  useEffect(() => {
    if (!open || cfg) return;
    void getVrcOscBridge()
      ?.getConfig()
      .then((c) => {
        if (!c) return;
        setCfg(c);
        setInPort(String(c.inPort));
        setOutPort(String(c.outPort));
      });
  }, [open, cfg]);

  const save = async (patch: Partial<VrcOscConfig>) => {
    const r = await getVrcOscBridge()?.setConfig(patch);
    if (r?.ok && r.config) {
      setCfg(r.config);
      setInPort(String(r.config.inPort));
      setOutPort(String(r.config.outPort));
    } else {
      toast.error("Ports must be 1024–65535 and different from each other.");
      if (cfg) {
        setInPort(String(cfg.inPort));
        setOutPort(String(cfg.outPort));
      }
    }
  };

  return (
    <div className="border-t border-white/10 pt-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-white">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Manual ports
      </button>
      {open && cfg && (
        <div className="mt-2 space-y-2">
          <label className="flex items-center justify-between gap-2 text-xs">
            Use fixed ports (VRChat launched with --osc)
            <Toggle size="sm" checked={cfg.manual} onChange={(m) => void save({ manual: m })} label="Use manual ports" />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1">
              Receive
              <input className="input w-20" inputMode="numeric" value={inPort} onChange={(e) => setInPort(e.target.value)} onBlur={() => Number(inPort) !== cfg.inPort && void save({ inPort: Number(inPort) })} aria-label="Receive port" />
            </label>
            <label className="flex items-center gap-1">
              Send
              <input className="input w-20" inputMode="numeric" value={outPort} onChange={(e) => setOutPort(e.target.value)} onBlur={() => Number(outPort) !== cfg.outPort && void save({ outPort: Number(outPort) })} aria-label="Send port" />
            </label>
          </div>
          <div className="text-xs text-muted">Default VRChat ports: it sends on 9001 and listens on 9000. Only used when fixed ports are on.</div>
        </div>
      )}
    </div>
  );
}
