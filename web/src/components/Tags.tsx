"use client";

import { useMemo, useRef, useState } from "react";
import { Tag as TagIcon, X } from "lucide-react";

export const MAX_TAGS = 3;

// Client-side mirror of lib/tags.ts normalizeTag — lowercase, trim, collapse
// whitespace. The server is authoritative; this just keeps the UI honest.
function normalize(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, " ");
}

// Read-only tag pills. Renders nothing when there are no tags.
export function TagChips({ tags, className = "" }: { tags: string[]; className?: string }) {
  if (!tags.length) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className}`}>
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center rounded-full bg-white/10 px-2.5 py-1 text-xs text-muted"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

// Inline tag editor with tab-to-fill autocomplete. Shows the current tags as
// removable pills plus an input that ghost-completes the best matching existing
// tag — Tab fills it, Enter adds it (creating the tag if it's new), Backspace on
// an empty input removes the last pill. Caps at MAX_TAGS.
export function TagEditor({
  value,
  suggestions,
  onChange,
  invalid = false,
}: {
  value: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
  // Highlight the field (e.g. a tag is required and none is set yet).
  invalid?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const full = value.length >= MAX_TAGS;

  // Best existing tag that extends what's typed (and isn't already applied).
  const ghost = useMemo(() => {
    const d = normalize(draft);
    if (!d) return "";
    const hit = suggestions.find((s) => s.startsWith(d) && s !== d && !value.includes(s));
    return hit ? hit.slice(d.length) : "";
  }, [draft, suggestions, value]);

  function add(raw: string) {
    const t = normalize(raw);
    if (!t || value.includes(t) || value.length >= MAX_TAGS) return;
    onChange([...value, t]);
    setDraft("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "Tab" || e.key === "ArrowRight") && ghost) {
      e.preventDefault();
      setDraft(normalize(draft) + ghost);
    } else if (e.key === "Enter") {
      e.preventDefault();
      add(draft + ghost); // Enter accepts the ghosted completion too
    } else if (e.key === "Backspace" && draft === "" && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className={`rounded-lg border bg-white/[0.03] p-2 transition-colors ${
        invalid ? "border-amber-400/70 ring-1 ring-amber-400/40" : "border-white/10"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <TagIcon size={12} className="text-muted shrink-0" />
        {value.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-white"
          >
            {t}
            <button
              type="button"
              onClick={() => onChange(value.filter((x) => x !== t))}
              className="text-muted hover:text-white"
              aria-label={`Remove tag ${t}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {!full && (
          // Overlay the ghost completion behind a transparent input so the typed
          // text and the suggested remainder line up exactly.
          <span className="relative inline-flex min-w-[80px] flex-1 items-center text-[11px]">
            <span className="pointer-events-none absolute inset-0 flex items-center whitespace-pre">
              <span className="invisible">{draft}</span>
              <span className="text-muted/60">{ghost}</span>
            </span>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => add(draft)}
              placeholder={value.length ? "add tag…" : "tag, Tab to fill…"}
              maxLength={30}
              className="w-full bg-transparent outline-none placeholder:text-muted/50"
              aria-label="Add a tag"
            />
          </span>
        )}
      </div>
    </div>
  );
}
