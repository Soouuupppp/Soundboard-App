"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Shield, LogOut, ChevronDown } from "lucide-react";

// Header avatar dropdown (Admin + Sign out). The storage quota meter moved out to
// <QuotaBar> in the 1.4.1 navbar refactor (it now spans beneath the right-cluster
// controls). `signOutAction` is the layout's server action, passed through.
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
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
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
        <span className="text-muted hidden md:inline max-w-[8rem] truncate">{name}</span>
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
  );
}
