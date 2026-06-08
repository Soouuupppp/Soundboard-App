"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/utils";

type Storage = { used: number; maxTotalStorage: number };

// Avatar + name + a compact storage meter for the nav bar. Storage is fetched
// client-side (and refetched on the `soundboard:storage-changed` event the
// dashboard fires after uploads/deletes) so it stays live without a reload.
export function UserBadge({ name, image }: { name: string | null; image: string | null }) {
  const [storage, setStorage] = useState<Storage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/sounds").then((x) => x.json());
        if (cancelled) return;
        if (typeof r?.used === "number" && r?.limits?.maxTotalStorage) {
          setStorage({ used: r.used, maxTotalStorage: r.limits.maxTotalStorage });
        }
      } catch {
        /* leave storage null — the meter just doesn't render */
      }
    };
    load();
    const onChange = () => load();
    window.addEventListener("soundboard:storage-changed", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("soundboard:storage-changed", onChange);
    };
  }, []);

  const pct = storage
    ? Math.min(100, (storage.used / storage.maxTotalStorage) * 100)
    : 0;

  return (
    <div className="flex items-center gap-3">
      {storage && (
        <div className="hidden sm:block w-32" title={`${formatBytes(storage.used)} of ${formatBytes(storage.maxTotalStorage)} used`}>
          <div className="flex justify-between text-[11px] text-muted leading-none mb-1">
            <span className="text-white/80">{formatBytes(storage.used)}</span>
            <span>{formatBytes(storage.maxTotalStorage)}</span>
          </div>
          <div className="w-full h-1.5 bg-white/[0.08] rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-grad transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-7 w-7 rounded-full border border-white/10" />
        ) : (
          <div className="h-7 w-7 rounded-full bg-white/5 border border-white/10" />
        )}
        <span className="text-muted hidden sm:inline">{name}</span>
      </div>
    </div>
  );
}
