"use client";

// Fires the anonymous "landing" analytics event when the logged-out landing page
// mounts (non-unique — every visit). No user is associated yet, so it's the top
// of the funnel: landing → login → tos_accept → new_user. No-op when GA is off.

import { useEffect } from "react";
import { analytics } from "@/lib/analytics";

export function LandingAnalytics() {
  useEffect(() => {
    analytics.landing();
  }, []);
  return null;
}
