import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkAiQuota, consumeAiSeconds } from "@/lib/ai-quota";
import { providerSts, appKeyFor, ProviderError, type AiProvider } from "@/lib/ai-providers";
import { aiProvider, aiVoiceId } from "@/lib/validation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// 30 MB ceiling — generous for the longest file STS (ElevenLabs ≤300s). Guards the
// buffer before formData() reads the body (mirrors the upload route's intent).
const MAX_BODY = 30 * 1024 * 1024;

// POST /api/ai/sts — same-origin proxy for paid speech-to-speech. multipart:
// `audio` (Blob), `provider`, `voiceId`, `seconds` (input-duration hint).
// BYO provider key via the `x-ai-key` header (never stored, never logged). App-key
// calls meter the input seconds against the user's monthly quota; BYO calls don't.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`ai-mut:${clientKey(req, session.user.id)}`, { capacity: 20, refillPerSec: 0.5 });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const len = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > MAX_BODY) {
    return NextResponse.json({ error: "audio too large" }, { status: 413 });
  }

  const byoKey = req.headers.get("x-ai-key")?.trim() || undefined;

  const quota = await checkAiQuota(session.user.id, { byo: !!byoKey });
  if (!quota.ok) return NextResponse.json({ error: quota.error }, { status: quota.status });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "invalid form" }, { status: 400 });

  const provParse = aiProvider.safeParse(form.get("provider"));
  const voiceParse = aiVoiceId.safeParse(form.get("voiceId"));
  const audio = form.get("audio");
  if (!provParse.success || !voiceParse.success) {
    return NextResponse.json({ error: "invalid provider/voice" }, { status: 400 });
  }
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "missing audio" }, { status: 400 });
  }
  if (audio.size > MAX_BODY) return NextResponse.json({ error: "audio too large" }, { status: 413 });

  const provider = provParse.data as AiProvider;
  const apiKey = byoKey ?? appKeyFor(provider);
  if (!apiKey) return NextResponse.json({ error: "provider not configured" }, { status: 503 });

  // Metered input seconds — client hint, clamped to [1, 300]. The PTT recorder is
  // capped client-side and the route is rate-limited, bounding any under-report.
  const secondsHint = Math.round(Number(form.get("seconds") ?? 0));
  const seconds = Number.isFinite(secondsHint) ? Math.min(300, Math.max(1, secondsHint)) : 1;

  try {
    const { audio: out, contentType } = await providerSts(provider, {
      audio,
      voiceId: voiceParse.data,
      apiKey,
    });
    if (!byoKey) await consumeAiSeconds(session.user.id, seconds);
    return new NextResponse(out, { headers: { "content-type": contentType, "cache-control": "no-store" } });
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : "conversion failed" }, { status });
  }
}
