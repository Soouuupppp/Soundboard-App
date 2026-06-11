import type { NextConfig } from "next";

// Static security headers. The Content-Security-Policy is intentionally NOT here:
// it's set per-request in middleware.ts so each response can carry a fresh nonce
// on `script-src` (which lets us drop `'unsafe-inline'`). Setting it in both
// places would emit two conflicting CSP headers.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Allow the app's own origin to use the microphone (in-app mic mixer) and to
  // pick audio output devices via setSinkId (speaker-selection). Everything else
  // stays locked down.
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=(), speaker-selection=(self)" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const config: NextConfig = {
  output: "standalone",
  experimental: {
    serverActions: { bodySizeLimit: "50mb" },
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "cdn.discordapp.com" }],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default config;
