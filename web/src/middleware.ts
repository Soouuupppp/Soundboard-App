import { NextResponse, type NextRequest } from "next/server";

// This middleware does two jobs on every (non-static) request:
//
// 1. CSRF defense for state-changing /api/* requests. We require the Origin
//    (or Referer, as a fallback) to match the request's own host. This blocks
//    cross-site form submissions — including the multipart/form-data upload
//    route, which is a CORS "simple request" and so isn't protected by a
//    preflight. Auth.js's own /api/auth/* routes have their own CSRF handling,
//    and Next.js natively guards Server Actions (page-route POSTs), so both are
//    exempt here.
//
// 2. A nonce-based Content-Security-Policy for document responses. The CSP lives
//    here (not in next.config.ts) so each response can carry a fresh per-request
//    nonce on `script-src`, which lets us drop `'unsafe-inline'`. Next.js reads
//    the nonce from the request's Content-Security-Policy header and applies it
//    to its own framework <script> tags automatically. The remaining static
//    security headers stay in next.config.ts.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// When a GA measurement id is configured (and not in local `next dev`), gtag.js
// loads from googletagmanager.com and beacons to *.google-analytics.com /
// *.analytics.google.com — so widen the CSP to those hosts. Absent / dev → no GA,
// no widening (default tight policy). Mirrors GA_ACTIVE in app/layout.tsx.
const GA_ENABLED =
  !!process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && process.env.NODE_ENV !== "development";
const GA_SCRIPT = GA_ENABLED ? " https://www.googletagmanager.com" : "";
const GA_IMG = GA_ENABLED ? " https://*.google-analytics.com https://www.googletagmanager.com" : "";
const GA_CONNECT = GA_ENABLED
  ? " https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com"
  : "";

function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    // No 'unsafe-inline': inline scripts must carry the nonce. Same-origin file
    // scripts (Next's /_next/ chunks) are covered by 'self'. We deliberately do
    // NOT use 'strict-dynamic' yet — 'self' is a more forgiving fallback for the
    // chunk loader, and this app never serves user-controlled JS from its origin
    // (uploads are mp3, streamed as audio/mpeg with nosniff). Tighten to
    // 'strict-dynamic' once verified in a real build if desired.
    `script-src 'self' 'nonce-${nonce}'${GA_SCRIPT}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: https://cdn.discordapp.com${GA_IMG}`,
    "media-src 'self' blob:",
    "font-src 'self' data:",
    // blob: lets the client-side clip editor (wavesurfer) fetch the in-memory
    // object URL it decodes the waveform from; the app creates those blobs itself.
    // The Hugging Face hosts are the AI voice-changer path (1.4.0): the browser
    // talks DIRECTLY to the r3gm/rvc_zero Space (via @gradio/client) so each user
    // spends their own per-IP ZeroGPU quota and we hold no HF token — a deliberate
    // privacy tradeoff (mic audio leaves the machine), disclosed in the UI. The
    // Space resolves to r3gm-rvc-zero.hf.space; uploads/SSE/file all hit *.hf.space,
    // and the model/index files resolve from huggingface.co. wss covers the Gradio
    // event stream. Converted audio returns as a blob: (already in media-src).
    `connect-src 'self' blob: https://*.hf.space wss://*.hf.space https://huggingface.co${GA_CONNECT}`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function middleware(req: NextRequest) {
  const isApi = req.nextUrl.pathname.startsWith("/api/");

  // --- 1. CSRF defense (state-changing API requests only) ---
  if (isApi && !SAFE_METHODS.has(req.method) && !req.nextUrl.pathname.startsWith("/api/auth/")) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    const host = req.headers.get("host");
    if (!host) return new NextResponse("missing host", { status: 400 });

    const expected = `${req.nextUrl.protocol}//${host}`;

    if (origin) {
      if (origin !== expected) return new NextResponse("bad origin", { status: 403 });
    } else if (referer) {
      // No Origin header (some non-browser clients / older same-origin navs).
      if (!referer.startsWith(expected + "/") && referer !== expected) {
        return new NextResponse("bad referer", { status: 403 });
      }
    } else {
      // Neither Origin nor Referer — refuse to be safe.
      return new NextResponse("missing origin", { status: 403 });
    }
  }

  // API responses are JSON and don't need a nonce/CSP — skip the work.
  if (isApi) return NextResponse.next();

  // --- 2. Nonce-based CSP for document responses ---
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  // Set the CSP on the *request* headers too: Next.js reads the nonce from here
  // and stamps it onto the framework's inline scripts. `x-nonce` is exposed for
  // any inline <script> we author ourselves (read it via headers() in a layout).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  // Everything except Next's static chunks and image optimizer: API routes (for
  // CSRF) and all document routes (for the nonce CSP).
  matcher: ["/((?!_next/static|_next/image).*)"],
};
