import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0d12",
        panel: "#141821",
        border: "#1f2532",
        accent: "#5865F2",
        accentHover: "#4752c4",
        muted: "#9aa3b2",
      },
    },
  },
  plugins: [],
};

export default config;
