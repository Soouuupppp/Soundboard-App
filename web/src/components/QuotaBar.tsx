"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/utils";

type Storage = { used: number; maxTotalStorage: number };

// Upload-storage quota meter. Lifted out of UserMenu in the 1.4.1 navbar refactor
// so it can span beneath the right-cluster controls (Settings · user · profile)
// as a thin bar. Fetched client-side and refetched on the
// `soundboard:storage-changed` event the dashboard fires after uploads/deletes,
// so it stays live without a reload.
export function QuotaBar({ className = "" }: { className?: string }) {
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

  if (!storage) return null;
  const pct = Math.min(100, (storage.used / storage.maxTotalStorage) * 100);

  return (
    <div
      className={className}
      title={`${formatBytes(storage.used)} of ${formatBytes(storage.maxTotalStorage)} used`}
    >
      <div className="flex justify-between text-[10px] text-muted leading-none mb-0.5">
        <span className="text-white/80">{formatBytes(storage.used)}</span>
        <span>{formatBytes(storage.maxTotalStorage)}</span>
      </div>
      <div className="w-full h-1 bg-white/[0.08] rounded-full overflow-hidden">
        <div
          className="h-full bg-accent-grad transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
