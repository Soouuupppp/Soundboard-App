import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "cdn.discordapp.com" }],
  },
};

export default config;
