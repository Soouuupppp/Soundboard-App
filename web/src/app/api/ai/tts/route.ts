import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkAiQuota, consumeAiSeconds } from "@/lib/ai-quota";
import { providerTts, appKeyFor, ProviderError, type AiProvider } from "@/lib/ai-providers";
import { PostAiTtsBody } from "@/lib/validation";
import { clientKey, rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

// POST /api/ai/tts — same-origin proxy for paid text-to-speech (the synth half of
// the STT→TTS "re-speak" feature). JSON: { provider, voiceId, text }. BYO key via
// `x-ai-key` (never stored). App-key calls meter the OUTPUT seconds (estimated from
// the text length, ~14 chars/sec) against the user's monthly quota; BYO calls don't.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rl = rateLimit(`ai-mut:${clientKey(req, session.user.id)}`, { capacity: 20, refillPerSec: 0.5 });
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const byoKey = req.headers.get("x-ai-key")?.trim() || undefined;

  const quota = await checkAiQuota(session.user.id, { byo: !!byoKey });
  if (!quota.ok) return NextResponse.json({ error: quota.error }, { status: quota.status });

  const parsed = PostAiTtsBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const { provider, voiceId, text } = parsed.data;

  const apiKey = byoKey ?? appKeyFor(provider as AiProvider);
  if (!apiKey) return NextResponse.json({ error: "provider not configured" }, { status: 503 });

  try {
    const { audio, contentType } = await providerTts(provider as AiProvider, { text, voiceId, apiKey });
    if (!byoKey) {
      const seconds = Math.min(300, Math.max(1, Math.ceil(text.length / 14)));
      await consumeAiSeconds(session.user.id, seconds);
    }
    return new NextResponse(audio, { headers: { "content-type": contentType, "cache-control": "no-store" } });
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : 502;
    return NextResponse.json({ error: e instanceof Error ? e.message : "synthesis failed" }, { status });
  }
}
