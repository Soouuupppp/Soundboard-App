"use client";

import { useEffect, useMemo, useState } from "react";
import { Play, Plus, Search } from "lucide-react";
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
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Search size={18} className="text-muted" />
        <input
          className="input max-w-md"
          placeholder="Search by name or uploader"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {filtered.length === 0 ? (
        <p className="text-muted">No public sounds yet.</p>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {filtered.map((s) => (
            <li key={s.id} className="card flex items-center gap-3">
              <button className="btn-primary" onClick={() => play(s.id)} title="Play">
                <Play size={16} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.name}</div>
                <div className="text-xs text-muted truncate">
                  {s.ownerName ?? "unknown"} · {formatBytes(s.sizeBytes)}
                </div>
              </div>
              <button
                className="btn-ghost text-xs"
                disabled={adding === s.id || added.has(s.id)}
                onClick={() => addToBoard(s.id)}
                title="Add to my board"
              >
                <Plus size={14} className="mr-1" />
                {added.has(s.id) ? "Added" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
