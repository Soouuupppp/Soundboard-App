import { NextResponse, type NextRequest } from "next/server";

// CSRF defense: for any state-changing request to /api/*, require that the
// Origin (or Referer, as a fallback for older clients) matches the request's
// own host. This blocks cross-site form submissions — including the
// multipart/form-data upload route, which is a CORS "simple request" and
// therefore not protected by preflight.
//
// Auth.js's own /api/auth/* routes have their own CSRF handling, so we exempt
// them here to avoid double-checks (and to keep OAuth callback POSTs working
// in edge cases like the Discord device flow).

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function middleware(req: NextRequest) {
  if (SAFE_METHODS.has(req.method)) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/auth/")) return NextResponse.next();

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const host = req.headers.get("host");
  if (!host) return new NextResponse("missing host", { status: 400 });

  const expected = `${req.nextUrl.protocol}//${host}`;

  if (origin) {
    if (origin !== expected) {
      return new NextResponse("bad origin", { status: 403 });
    }
    return NextResponse.next();
  }

  // No Origin header (some non-browser clients, or older browsers on same-origin
  // navigations). Fall back to Referer prefix check.
  if (referer) {
    if (!referer.startsWith(expected + "/") && referer !== expected) {
      return new NextResponse("bad referer", { status: 403 });
    }
    return NextResponse.next();
  }

  // Neither Origin nor Referer — refuse to be safe.
  return new NextResponse("missing origin", { status: 403 });
}

export const config = {
  matcher: ["/api/:path*"],
};
