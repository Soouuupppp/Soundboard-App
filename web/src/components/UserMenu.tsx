"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Shield, LogOut, ChevronDown } from "lucide-react";
import { formatBytes } from "@/lib/utils";

type Storage = { used: number; maxTotalStorage: number };

// Header storage meter + avatar dropdown (Admin + Sign out). Storage is fetched
// client-side (and refetched on the `soundboard:storage-changed` event the
// dashboard fires after uploads/deletes) so the quota meter stays live without a
// reload. `signOutAction` is the layout's server action, passed through.
export function UserMenu({
  name,
  image,
  isAdmin,
  signOutAction,
}: {
  name: string | null;
  image: string | null;
  isAdmin: boolean;
  signOutAction: () => void;
}) {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Outside-click + Escape close the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pct = storage ? Math.min(100, (storage.used / storage.maxTotalStorage) * 100) : 0;

  return (
    <div className="flex items-center gap-3">
      {storage && (
        <div
          className="hidden sm:block w-32"
          title={`${formatBytes(storage.used)} of ${formatBytes(storage.maxTotalStorage)} used`}
        >
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

      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-2 rounded-full p-0.5 pr-2 transition hover:bg-white/[0.06]"
        >
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="h-7 w-7 rounded-full border border-white/10" />
          ) : (
            <div className="h-7 w-7 rounded-full bg-white/5 border border-white/10" />
          )}
          <span className="text-muted hidden sm:inline max-w-[10rem] truncate">{name}</span>
          <ChevronDown size={14} className="text-muted shrink-0" />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-44 popover rounded-lg p-1 shadow-xl z-30"
          >
            {isAdmin && (
              <Link
                href="/admin"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-white/5 hover:text-white"
              >
                <Shield size={14} /> Admin
              </Link>
            )}
            <form action={signOutAction}>
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-muted hover:bg-white/5 hover:text-white"
              >
                <LogOut size={14} /> Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
