import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // `--font-play` is injected by next/font in app/layout.tsx.
        sans: [
          "var(--font-play)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      colors: {
        bg: "#070811",
        panel: "#11141e",
        border: "rgba(255,255,255,0.08)",
        accent: "#7C8CFF",
        accentHover: "#6677FF",
        muted: "#9aa3b2",
        glass: "rgba(20, 24, 36, 0.55)",
        glassStrong: "rgba(20, 24, 36, 0.72)",
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.05)",
        glow: "0 0 24px rgba(124,140,255,0.35)",
      },
      backgroundImage: {
        "accent-grad": "linear-gradient(135deg, #7C8CFF 0%, #5865F2 100%)",
        "ambient":
          "radial-gradient(1200px 600px at 10% -10%, rgba(124,140,255,0.18), transparent 60%), radial-gradient(900px 500px at 110% 10%, rgba(216,99,255,0.14), transparent 55%), radial-gradient(700px 500px at 50% 120%, rgba(70,200,255,0.10), transparent 60%)",
      },
    },
  },
  plugins: [],
};

export default config;
