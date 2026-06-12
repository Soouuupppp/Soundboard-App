"use client";

// A dark, glassy replacement for the native <select> — the OS popup renders
// white/gray and breaks the theme. The trigger is styled like `.input`; the
// menu is rendered through a portal with fixed positioning so it escapes any
// `overflow-hidden`/`overflow-x-auto` ancestor (e.g. the admin tables) instead
// of being clipped, mirroring how a native select floats above everything.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";

export type SelectOption = { value: string; label: ReactNode };

type Props = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Extra classes for the trigger button (sizing/overrides, like the old select). */
  className?: string;
  /** Shown when `value` matches no option. */
  placeholder?: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
};

export function Select({
  value,
  onChange,
  options,
  className = "",
  placeholder,
  disabled,
  "aria-label": ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Index the keyboard cursor lands on; -1 = none highlighted yet.
  const [active, setActive] = useState(-1);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  const reposition = useCallback(() => {
    if (btnRef.current) setRect(btnRef.current.getBoundingClientRect());
  }, []);

  // Keep the portalled menu pinned to the trigger while it's open.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  // Outside-click + Escape close. Capture phase so it beats inner handlers.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function openMenu() {
    if (disabled) return;
    setActive(options.findIndex((o) => o.value === value));
    setOpen(true);
  }

  function commit(v: string) {
    onChange(v);
    setOpen(false);
    btnRef.current?.focus();
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (active >= 0) commit(options[active].value);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`input flex items-center justify-between gap-2 text-left disabled:opacity-50 disabled:pointer-events-none ${className}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        <span className="truncate">
          {selected ? selected.label : <span className="text-muted">{placeholder}</span>}
        </span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            className="glass fixed z-[60] max-h-64 overflow-y-auto rounded-lg p-1 shadow-xl"
            style={{
              top: rect.bottom + 4,
              left: rect.left,
              minWidth: rect.width,
            }}
          >
            {options.map((o, i) => {
              const isSel = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={isSel}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition ${
                    i === active ? "bg-white/10" : "hover:bg-white/5"
                  } ${isSel ? "text-white" : "text-muted"}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(o.value)}
                >
                  <span className="truncate">{o.label}</span>
                  {isSel && <Check size={14} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
