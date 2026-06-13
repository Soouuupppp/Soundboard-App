"use client";

// Notice banners shown below the header to signed-in users:
//  • MotdBanner — the admin-set message-of-the-day (dismissible, re-shows on a
//    content change, a new local day, or an app restart). Polls so an admin's
//    change appears without a refresh.
//  • DesktopPromoBanner — a web-only "get the desktop app" promo, shown only when
//    NOT running inside the Electron wrapper (no window.soundboard). Non-dismissible.
// Both are client components: they read sessionStorage / window, so they render
// nothing until mounted to avoid an SSR flash.

import { useEffect, useState } from "react";
import { Info, AlertTriangle, CheckCircle2, Download, X } from "lucide-react";

export type MotdSeverity = "info" | "warning" | "success";

export type Motd = {
  enabled: boolean;
  message: string;
  linkLabel: string | null;
  linkUrl: string | null;
  severity: MotdSeverity;
  // Dismissal version token (motdUpdatedAt epoch ms as a string, "" if never set).
  version: string;
};

const DESKTOP_RELEASES_URL =
  "https://github.com/Soouuupppp/Soundboard-App/releases/latest";
const MOTD_DISMISS_KEY = "soundboard:motdDismissed";

// Local calendar day (YYYY-MM-DD) so dismissals last only for the current day.
function todayKey(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const SEVERITY: Record<
  MotdSeverity,
  { wrap: string; icon: React.ReactNode; link: string }
> = {
  info: {
    wrap: "border-accent/30 bg-accent/10 text-white",
    icon: <Info size={16} className="text-accent shrink-0" />,
    link: "text-accent hover:underline",
  },
  warning: {
    wrap: "border-amber-400/30 bg-amber-400/10 text-white",
    icon: <AlertTriangle size={16} className="text-amber-300 shrink-0" />,
    link: "text-amber-200 hover:underline",
  },
  success: {
    wrap: "border-emerald-400/30 bg-emerald-400/10 text-white",
    icon: <CheckCircle2 size={16} className="text-emerald-300 shrink-0" />,
    link: "text-emerald-200 hover:underline",
  },
};

const MOTD_POLL_MS = 60_000;

function MotdBanner({ initial }: { initial: Motd }) {
  const [mounted, setMounted] = useState(false);
  // Seeded from the server-rendered value (no flash), then refreshed by polling.
  const [motd, setMotd] = useState<Motd>(initial);
  const [dismissal, setDismissal] = useState<{ version: string; date: string } | null>(null);

  // Read the stored dismissal once on mount. Stored in sessionStorage (not
  // localStorage) so it clears on app restart / a new tab session — a dismissed
  // banner re-shows on restart, as well as on a content change (version) or a new
  // local day (date), per the owner's "update & daily & restart" decision.
  useEffect(() => {
    setMounted(true);
    try {
      const raw = sessionStorage.getItem(MOTD_DISMISS_KEY);
      if (raw) setDismissal(JSON.parse(raw) as { version: string; date: string });
    } catch {
      /* ignore malformed storage */
    }
  }, []);

  // Poll so an admin's edit / enable appears without a page refresh. When the
  // version changes the dismissal no longer matches, so the banner re-shows.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/motd");
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && j?.motd) setMotd(j.motd as Motd);
      } catch {
        /* keep last known value */
      }
    };
    const id = setInterval(load, MOTD_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!mounted) return null;
  if (!motd.enabled || !motd.message.trim()) return null;
  // Dismissed only while both the content (version) and the local day still match.
  if (dismissal && dismissal.version === motd.version && dismissal.date === todayKey()) return null;

  const sev = SEVERITY[motd.severity] ?? SEVERITY.info;

  const dismiss = () => {
    const rec = { version: motd.version, date: todayKey() };
    setDismissal(rec);
    try {
      sessionStorage.setItem(MOTD_DISMISS_KEY, JSON.stringify(rec));
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      role="status"
      className={`flex items-start gap-2.5 rounded-xl border px-4 py-2.5 text-sm ${sev.wrap}`}
    >
      {sev.icon}
      <div className="min-w-0 flex-1">
        <span className="whitespace-pre-wrap break-words">{motd.message}</span>
        {motd.linkUrl && (
          <>
            {" "}
            <a
              href={motd.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`font-medium ${sev.link}`}
            >
              {motd.linkLabel?.trim() || "Learn more"}
            </a>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notice"
        className="shrink-0 rounded-md p-1 text-muted hover:bg-white/10 hover:text-white"
      >
        <X size={15} />
      </button>
    </div>
  );
}

function DesktopPromoBanner() {
  // Show only in the web build — i.e. when the Electron preload's
  // window.soundboard bridge is absent. Checked after mount so SSR never flashes
  // it (and it never renders inside the desktop wrapper).
  const [isWeb, setIsWeb] = useState(false);
  useEffect(() => {
    setIsWeb(!(window as unknown as { soundboard?: unknown }).soundboard);
  }, []);

  if (!isWeb) return null;

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-muted">
      <Download size={16} className="text-accent shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="text-white">Get the desktop app</span> for global hotkeys and VR
        controller binds that work even when the app isn&apos;t focused.{" "}
        <a
          href={DESKTOP_RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-accent hover:underline"
        >
          Download for Windows
        </a>
      </div>
    </div>
  );
}

// Banner stack rendered below the nav for signed-in users only (the parent
// layout gates on the session before rendering this).
export function NoticeBanners({ motd }: { motd: Motd }) {
  return (
    <div className="max-w-[1800px] mx-auto px-4 mt-3 flex flex-col gap-2">
      <MotdBanner initial={motd} />
      <DesktopPromoBanner />
    </div>
  );
}
