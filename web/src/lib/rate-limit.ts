// Simple in-memory token-bucket rate limiter. One process only — fine for the
// current single-container deployment. Swap for Redis if/when we scale out.

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();

// Periodic eviction so the map can't grow unbounded.
let lastSweep = Date.now();
function maybeSweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (now - b.updatedAt > 10 * 60_000) buckets.delete(k);
  }
}

export type RateLimitOptions = {
  /** Bucket capacity (max burst). */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
};

export type RateLimitResult = {
  ok: boolean;
  /** Seconds until the next token is available. 0 when ok. */
  retryAfter: number;
};

export function rateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  maybeSweep(now);
  const b = buckets.get(key) ?? { tokens: opts.capacity, updatedAt: now };
  const elapsedSec = (now - b.updatedAt) / 1000;
  const refilled = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec);
  if (refilled >= 1) {
    buckets.set(key, { tokens: refilled - 1, updatedAt: now });
    return { ok: true, retryAfter: 0 };
  }
  buckets.set(key, { tokens: refilled, updatedAt: now });
  const need = 1 - refilled;
  return { ok: false, retryAfter: Math.ceil(need / opts.refillPerSec) };
}

/** Resolve a stable key for the caller: user id if logged in, else best-effort IP. */
export function clientKey(req: Request, userId: string | null): string {
  if (userId) return `u:${userId}`;
  // Behind Cloudflare, CF-Connecting-IP is the real client IP and is rewritten by
  // Cloudflare on every request, so it can't be spoofed by the client. Prefer it
  // over X-Forwarded-For, whose first entry a client *can* pre-populate to dodge
  // an IP-keyed limit. (All current rate-limited routes key on userId, so this
  // only matters if/when an unauthenticated rate-limited endpoint is added.)
  const cf = req.headers.get("cf-connecting-ip");
  const xff = req.headers.get("x-forwarded-for");
  const ip = cf?.trim() || xff?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "anon";
  return `ip:${ip}`;
}

import { NextResponse } from "next/server";

/** Convenience: produces a 429 response with Retry-After header. */
export function tooManyRequests(retryAfter: number) {
  return NextResponse.json(
    { error: "rate limited", retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } }
  );
}
