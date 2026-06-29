"use client";

// Fires the app_open / app_close analytics pair (see lib/analytics). Mounted once
// in the root layout, only when GA is configured. `app_open` fires on mount;
// `app_close` fires on pagehide (more reliable than beforeunload, and it covers
// the Electron window closing) via the gtag beacon transport. Both carry the
// gtag-config user_id, so GA can derive per-user session/use-time.

import { useEffect } from "react";
import { analytics } from "@/lib/analytics";

export function AnalyticsLifecycle({ signedIn = false }: { signedIn?: boolean }) {
  useEffect(() => {
    analytics.appOpen();
    // Fire `login` once per browser session for an authenticated user (a proxy
    // for "logged in" — covers the OAuth redirect AND opening the app while a
    // session cookie is still valid). sessionStorage clears on browser close.
    if (signedIn) {
      try {
        if (!sessionStorage.getItem("ga:login")) {
          sessionStorage.setItem("ga:login", "1");
          analytics.login();
        }
      } catch { /* storage blocked — skip */ }
    }
    const onHide = () => analytics.appClose();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [signedIn]);
  return null;
}
