"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Sticky header that slides up when you scroll down and reappears when you
// scroll up (the dashboard is one long page, so this hands the full viewport
// back while browsing but keeps the controls a flick away). Always shown near
// the very top; small jitters are ignored via a movement threshold.
export function SiteHeader({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const dy = y - lastY.current;
      if (y < 64 || dy < -6) setHidden(false);
      else if (dy > 6) setHidden(true);
      lastY.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-20 border-b border-white/5 bg-black/30 backdrop-blur-xl transition-transform duration-300 ${
        hidden ? "-translate-y-full" : "translate-y-0"
      }`}
    >
      {children}
    </header>
  );
}
