"use client";

// Shared anchored popover (generalised from the UserMenu dropdown pattern): a
// trigger with an absolutely-positioned `.popover` panel that closes on
// outside-click / Escape. Open state is controlled by the parent so a group of
// popovers can enforce "one open at a time" (see HeaderControls).
//
// Two positioning modes:
//   - default (absolute): the panel is positioned relative to the trigger's
//     wrapper. Fine for header popovers that live in a stable, top-of-page spot.
//   - portal: the panel renders through a portal to <body> with `position:fixed`
//     and viewport-clamped coordinates computed from the trigger rect. Use this
//     for popovers anchored to elements inside scrolling/stacking containers
//     (e.g. a per-card button in the board grid) where an absolute panel would be
//     trapped behind later cards and clip off-screen.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const GAP = 8; // px between trigger and panel
const MARGIN = 8; // px min distance from the viewport edge

export function Popover({
  open,
  onClose,
  trigger,
  children,
  align = "right",
  panelClassName = "",
  portal = false,
}: {
  open: boolean;
  onClose: () => void;
  // The clickable trigger (button) — rendered inside the anchor wrapper so an
  // outside-click check treats a click on it as "inside" (the parent toggles).
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  panelClassName?: string;
  portal?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // Ignore clicks inside the panel itself, or inside any portalled `.popover`
      // surface (e.g. the shared Select menu, which renders through a portal to
      // document.body — outside this ref's subtree). Without this, picking a
      // Select option reads as an outside click and closes the popover on
      // mousedown, before the option's click→commit can apply.
      if (ref.current?.contains(t) || panelRef.current?.contains(t) || t?.closest?.(".popover")) return;
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

  // Portal mode: compute a viewport-clamped fixed position from the trigger rect
  // (recomputed on scroll/resize so the panel stays anchored). Measured after the
  // panel mounts so we know its size; kept hidden until positioned to avoid flicker.
  useLayoutEffect(() => {
    if (!open || !portal) return;
    const place = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Horizontal: right-align the panel's right edge to the trigger, or left-align.
      let left = align === "right" ? anchor.right - panel.width : anchor.left;
      left = Math.min(Math.max(left, MARGIN), vw - panel.width - MARGIN);
      // Vertical: below the trigger; if it would overflow the bottom, clamp up so
      // the whole panel stays on screen (it has its own max-height + scroll).
      let top = anchor.bottom + GAP;
      if (top + panel.height > vh - MARGIN) top = vh - MARGIN - panel.height;
      top = Math.max(top, MARGIN);
      setPos({ top, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, portal, align]);

  // Reset the computed position when closed so the next open re-measures.
  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  const panelBase = `popover rounded-xl shadow-xl overflow-x-hidden ${panelClassName}`;

  return (
    <div className="relative" ref={ref}>
      {trigger}
      {open && !portal && (
        <div
          role="dialog"
          // overflow-x-hidden is always on: a scrollable popover (overflow-y-auto)
          // would otherwise promote overflow-x to auto per CSS spec and show a
          // spurious horizontal scrollbar once the vertical one appears.
          className={`absolute ${align === "right" ? "right-0" : "left-0"} mt-2 z-40 ${panelBase}`}
        >
          {children}
        </div>
      )}
      {open && portal && typeof document !== "undefined" && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          className={`fixed z-50 ${panelBase}`}
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? "visible" : "hidden",
          }}
        >
          {children}
        </div>,
        document.body,
      )}
    </div>
  );
}
