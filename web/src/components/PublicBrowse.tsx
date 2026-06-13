"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Plus, Search, Check, ChevronLeft, ChevronRight, Globe } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { useAudio } from "@/components/AudioProvider";
import { TagChips } from "@/components/Tags";
import { useToast } from "@/components/Toast";

type PublicSound = {
  id: string;
  name: string;
  sizeBytes: number;
  ownerName: string | null;
  ownerImage: string | null;
  mine: boolean;
  tags: string[];
};

export function PublicBrowse() {
  const toast = useToast();
  const [sounds, setSounds] = useState<PublicSound[]>([]);
  const [q, setQ] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/public/sounds")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j) => setSounds(j.sounds ?? []))
      .catch(() => toast.error("Couldn't load public sounds."));
  }, [toast]);

  const audio = useAudio();

  // The viewer's own public clips get their own showcase row up top; everything
  // else is the browsable grid below.
  const mine = useMemo(() => sounds.filter((s) => s.mine), [sounds]);
  const others = useMemo(() => sounds.filter((s) => !s.mine), [sounds]);

  // Tags available to filter by — the union of tags across browsable clips.
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of others) for (const t of s.tags) set.add(t);
    return [...set].sort();
  }, [others]);

  // Drop any selected tag that no longer exists in the browsable set.
  useEffect(() => {
    setSelectedTags((sel) => sel.filter((t) => availableTags.includes(t)));
  }, [availableTags]);

  // Browse grid: search (name/uploader) + tag filter (match ANY selected tag).
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return others.filter((s) => {
      if (needle && !s.name.toLowerCase().includes(needle) && !(s.ownerName ?? "").toLowerCase().includes(needle))
        return false;
      if (selectedTags.length && !selectedTags.some((t) => s.tags.includes(t))) return false;
      return true;
    });
  }, [others, q, selectedTags]);

  function toggleTag(t: string) {
    setSelectedTags((sel) => (sel.includes(t) ? sel.filter((x) => x !== t) : [...sel, t]));
  }

  async function addToBoard(soundId: string) {
    setAdding(soundId);
    let res: Response;
    try {
      res = await fetch("/api/board", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soundId }),
      });
    } catch {
      setAdding(null);
      toast.error("Network error — couldn't add that clip.");
      return;
    }
    setAdding(null);
    if (res.ok) {
      setAdded((s) => new Set(s).add(soundId));
      toast.success("Added to your board.");
    } else {
      await toast.fromResponse(res, "Couldn't add that clip");
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Public sounds</h1>
          <p className="text-muted mt-1">Browse what the community shared and add to your board.</p>
        </div>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="input pl-9 w-72"
            placeholder="Search by name or uploader"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {mine.length > 0 && (
        <section>
          <h2 className="section-title mb-3 flex items-center gap-2">
            <Globe size={16} className="text-accent" /> Your public clips
            <span className="chip">{mine.length}</span>
          </h2>
          <Carousel>
            {mine.map((s) => (
              <MineCard key={s.id} sound={s} onPlay={() => audio.play(s.id, 1, undefined, true)} />
            ))}
          </Carousel>
        </section>
      )}

      {availableTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted mr-1">Filter by tag:</span>
          {availableTags.map((t) => {
            const on = selectedTags.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleTag(t)}
                className={`rounded-full px-3 py-1 text-xs transition ${
                  on ? "bg-accent text-white" : "bg-white/[0.06] text-muted hover:bg-white/10 hover:text-white"
                }`}
              >
                {t}
              </button>
            );
          })}
          {selectedTags.length > 0 && (
            <button
              type="button"
              onClick={() => setSelectedTags([])}
              className="text-xs text-muted hover:text-white underline underline-offset-2"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="card text-center py-12 text-muted">
          {others.length === 0
            ? "No public sounds from others yet — be the first to share one."
            : "No matches."}
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {filtered.map((s) => {
            const isAdded = added.has(s.id);
            return (
              <li key={s.id} className="card group flex items-center gap-3 hover:border-white/20 transition">
                <button
                  className="btn-primary !rounded-xl !px-3 !py-2.5 shrink-0"
                  onClick={() => audio.play(s.id, 1, undefined, true)}
                  title="Play"
                  aria-label={`Play ${s.name}`}
                >
                  <Play size={16} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.name}</div>
                  <div className="text-xs text-muted truncate mt-0.5">
                    {s.ownerName ?? "unknown"} · {formatBytes(s.sizeBytes)}
                  </div>
                  {s.tags.length > 0 && <TagChips tags={s.tags} className="mt-1.5" />}
                </div>
                <button
                  className={isAdded ? "btn-ghost text-xs !text-emerald-300 !border-emerald-400/30" : "btn-ghost text-xs"}
                  disabled={adding === s.id || isAdded}
                  onClick={() => addToBoard(s.id)}
                  title="Add to my board"
                >
                  {isAdded ? <Check size={14} className="mr-1" /> : <Plus size={14} className="mr-1" />}
                  {isAdded ? "Added" : "Add"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Compact card for the viewer's own public clips row — play + name + tags. No
// "Add" (you can't add your own clip from public; manage it on your board).
function MineCard({ sound, onPlay }: { sound: PublicSound; onPlay: () => void }) {
  return (
    <div className="card w-56 shrink-0 flex items-center gap-3 snap-start">
      <button
        className="btn-primary !rounded-xl !px-3 !py-2.5 shrink-0"
        onClick={onPlay}
        title="Play"
        aria-label={`Play ${sound.name}`}
      >
        <Play size={16} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{sound.name}</div>
        <div className="text-xs text-muted truncate mt-0.5">{formatBytes(sound.sizeBytes)}</div>
        {sound.tags.length > 0 && <TagChips tags={sound.tags} className="mt-1.5" />}
      </div>
    </div>
  );
}

// Horizontal scroll row with prev/next buttons that appear only when the
// content actually overflows. Buttons disable at each end.
function Carousel({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  function update() {
    const el = ref.current;
    if (!el) return;
    setOverflow(el.scrollWidth > el.clientWidth + 1);
    setAtStart(el.scrollLeft <= 1);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
  }

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  function scrollBy(dir: number) {
    ref.current?.scrollBy({ left: dir * Math.max(240, ref.current.clientWidth * 0.8), behavior: "smooth" });
  }

  return (
    <div className="relative">
      {overflow && (
        <button
          type="button"
          onClick={() => scrollBy(-1)}
          disabled={atStart}
          className="absolute left-0 top-1/2 z-10 -translate-y-1/2 -translate-x-1 rounded-full bg-black/60 border border-white/10 p-1.5 backdrop-blur disabled:opacity-30 hover:bg-black/80"
          aria-label="Scroll left"
        >
          <ChevronLeft size={18} />
        </button>
      )}
      <div
        ref={ref}
        onScroll={update}
        className="flex gap-3 overflow-x-auto pb-2 snap-x scroll-px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {overflow && (
        <button
          type="button"
          onClick={() => scrollBy(1)}
          disabled={atEnd}
          className="absolute right-0 top-1/2 z-10 -translate-y-1/2 translate-x-1 rounded-full bg-black/60 border border-white/10 p-1.5 backdrop-blur disabled:opacity-30 hover:bg-black/80"
          aria-label="Scroll right"
        >
          <ChevronRight size={18} />
        </button>
      )}
    </div>
  );
}
