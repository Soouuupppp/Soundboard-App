"use client";

// Shared anchored popover (generalised from the UserMenu dropdown pattern): a
// trigger with an absolutely-positioned `.popover` panel that closes on
// outside-click / Escape. Open state is controlled by the parent so a group of
// popovers can enforce "one open at a time" (see HeaderControls).

import { useEffect, useRef, type ReactNode } from "react";

export function Popover({
  open,
  onClose,
  trigger,
  children,
  align = "right",
  panelClassName = "",
}: {
  open: boolean;
  onClose: () => void;
  // The clickable trigger (button) — rendered inside the anchor wrapper so an
  // outside-click check treats a click on it as "inside" (the parent toggles).
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  panelClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // Ignore clicks inside the panel itself, or inside any portalled `.popover`
      // surface (e.g. the shared Select menu, which renders through a portal to
      // document.body — outside this ref's subtree). Without this, picking a
      // Select option reads as an outside click and closes the popover on
      // mousedown, before the option's click→commit can apply.
      if (ref.current?.contains(t) || t?.closest?.(".popover")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div className="relative" ref={ref}>
      {trigger}
      {open && (
        <div
          role="dialog"
          className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-2 popover rounded-xl shadow-xl z-40 ${panelClassName}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
