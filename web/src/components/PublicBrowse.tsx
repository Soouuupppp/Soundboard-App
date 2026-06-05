"use client";

import { useEffect, useMemo, useState } from "react";
import { Play, Plus, Search, Check } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { useAudioOutput } from "@/lib/audio-output";

type PublicSound = {
  id: string;
  name: string;
  sizeBytes: number;
  ownerId: string;
  ownerName: string | null;
  ownerImage: string | null;
};

export function PublicBrowse() {
  const [sounds, setSounds] = useState<PublicSound[]>([]);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/public/sounds")
      .then((r) => r.json())
      .then((j) => setSounds(j.sounds ?? []));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return sounds;
    return sounds.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        (s.ownerName ?? "").toLowerCase().includes(needle)
    );
  }, [sounds, q]);

  async function addToBoard(soundId: string) {
    setAdding(soundId);
    const res = await fetch("/api/board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ soundId }),
    });
    setAdding(null);
    if (res.ok) setAdded((s) => new Set(s).add(soundId));
  }

  const audio = useAudioOutput();
  function play(id: string) {
    audio.play(id);
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

      {filtered.length === 0 ? (
        <div className="card text-center py-12 text-muted">
          {q ? "No matches." : "No public sounds yet — be the first to share one."}
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {filtered.map((s) => {
            const isAdded = added.has(s.id);
            return (
              <li
                key={s.id}
                className="card group flex items-center gap-3 hover:border-white/20 transition"
              >
                <button
                  className="btn-primary !rounded-xl !px-3 !py-2.5 shrink-0"
                  onClick={() => play(s.id)}
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
