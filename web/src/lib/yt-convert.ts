// In-process YouTube→soundbite conversion worker.
//
//   enqueue(jobId) ──▶ [ queue ] ──▶ pump (≤ ytConcurrency in flight)
//                                       │
//                                       ▼
//        yt-dlp (bestaudio, -x mp3, duration + size capped) ──▶ tmp/<title>.mp3
//                                       │
//                                       ▼
//        validate (magic bytes, size, per-user quota) ──▶ persistSound() ──▶ job=done
//
// Single-process only, matching the in-memory rate limiter. Jobs left running
// when the process dies are failed on next boot by bootstrap.sql.

import { execFile, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversionJobs, sounds, users } from "@/db/schema";
import { getAppSettings, getYtConfigForUser, parseAllowedHosts } from "@/lib/app-settings";
import { getUserLimits, getUsedBytes } from "@/lib/quota";
import { looksLikeMp3, persistSound } from "@/lib/sounds";
import { deleteStorageFile } from "@/lib/storage";
import { soundName } from "@/lib/validation";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Optional Netscape cookies.txt to satisfy YouTube's "confirm you're not a bot"
// check (which routinely fires on datacenter/VPS IPs). Mounted read-only into
// the container at this path — see docker-compose.yml. Absent/empty → no
// --cookies, which is fine for IPs YouTube doesn't challenge.
const COOKIES_PATH = process.env.YTDLP_COOKIES?.trim() || "/secrets/yt-cookies.txt";
// Optional outbound proxy (e.g. a residential/SOCKS5 endpoint). The reliable fix
// when YouTube blocks the server's datacenter IP with "confirm you're not a bot"
// even with valid cookies. Unset = direct connection.
const PROXY = process.env.YTDLP_PROXY?.trim() || null;
// Optional extra yt-dlp --extractor-args, e.g. "youtube:player_client=tv" to try
// a client that may dodge the bot check without a proxy. Unset = none.
const EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS?.trim() || null;
// Hard wall-clock ceiling per job so a stuck download can't hold a slot forever.
const JOB_TIMEOUT_MS = 180_000;

// Queue entries carry the requester so the pump can enforce a per-role
// concurrency cap (resolved per user) on top of the global worker-pool size.
const queue: { jobId: string; userId: string }[] = [];
let active = 0;
const activeByUser = new Map<string, number>();

// Cancellation bookkeeping: the running yt-dlp child per job (so it can be
// killed) and a set of jobs the caller cancelled (checked at runJob checkpoints
// so a killed/finished job never persists a sound).
const running = new Map<string, ChildProcess>();
const cancelledJobs = new Set<string>();

// Cancel an in-flight (queued or running) conversion: dequeue it, kill the
// yt-dlp process (its temp dir is removed by runJob's finally), delete any sound
// that already landed (cancel racing the finish), and mark the job cancelled.
// Caller is responsible for auth/ownership. Safe to call for any state.
export async function cancelConversion(jobId: string): Promise<void> {
  cancelledJobs.add(jobId);

  // Drop it from the queue if it hasn't started.
  const qi = queue.findIndex((q) => q.jobId === jobId);
  if (qi !== -1) queue.splice(qi, 1);

  // Kill the running download, if any.
  const child = running.get(jobId);
  if (child) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }

  // If the sound already persisted (cancel raced the done-update), remove it
  // (cascades board entries / placements) and its file.
  const [job] = await db.select().from(conversionJobs).where(eq(conversionJobs.id, jobId)).limit(1);
  if (job?.soundId) {
    const [snd] = await db.select().from(sounds).where(eq(sounds.id, job.soundId)).limit(1);
    if (snd) {
      await db.delete(sounds).where(eq(sounds.id, snd.id));
      await deleteStorageFile(snd.storagePath).catch(() => {});
    }
  }

  await db
    .update(conversionJobs)
    .set({ status: "error", error: "cancelled", soundId: null, updatedAt: new Date() })
    .where(eq(conversionJobs.id, jobId));
  console.log(`[yt-convert] job ${jobId} cancelled`);
}

// Validate a URL's host against the admin allowlist. Returns the parsed URL or
// null. Exact host match only — blocks file://, internal IPs, and other
// extractors (anti-SSRF / anti-abuse).
export function hostAllowed(rawUrl: string, allowedHosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return allowedHosts.includes(u.hostname.toLowerCase());
}

export function enqueueConversion(jobId: string, userId: string) {
  queue.push({ jobId, userId });
  void pump();
}

async function pump() {
  // Re-read settings each tick so admin changes take effect for new jobs. The
  // global ytConcurrency is the shared worker-pool size; each user is
  // additionally capped at their role's resolved concurrency.
  const { ytConcurrency } = await getAppSettings();
  while (active < ytConcurrency) {
    // Find the first queued job whose user is still under their per-user cap.
    let idx = -1;
    for (let i = 0; i < queue.length; i++) {
      const { userId } = queue[i];
      const { concurrency } = await getYtConfigForUser(userId);
      if ((activeByUser.get(userId) ?? 0) < concurrency) {
        idx = i;
        break;
      }
    }
    if (idx === -1) break; // nothing runnable right now

    const { jobId, userId } = queue.splice(idx, 1)[0];
    active++;
    activeByUser.set(userId, (activeByUser.get(userId) ?? 0) + 1);
    void runJob(jobId).finally(() => {
      active--;
      activeByUser.set(userId, Math.max(0, (activeByUser.get(userId) ?? 1) - 1));
      void pump();
    });
  }
}

async function fail(jobId: string, message: string) {
  // Central log point for every failure reason (early returns + the catch), so
  // nothing fails silently. The catch separately logs the raw cause/stderr.
  console.warn(`[yt-convert] job ${jobId} failed: ${message}`);
  await db
    .update(conversionJobs)
    .set({ status: "error", error: message, updatedAt: new Date() })
    .where(eq(conversionJobs.id, jobId));
}

// Resolve --cookies args for a job. Only pass cookies when a non-empty file is
// actually mounted (an empty/absent jar makes yt-dlp bail on a "malformed
// cookies file"). The mount is read-only, but yt-dlp rewrites the jar on exit
// and crashes if it can't — so copy into the job's writable temp dir and point
// at the copy. The copy dies with workDir; the mounted source stays pristine.
async function cookieArgs(workDir: string): Promise<string[]> {
  let st;
  try {
    st = await fs.stat(COOKIES_PATH);
  } catch {
    return []; // nothing mounted — run without cookies
  }
  if (!st.isFile() || st.size === 0) return []; // empty placeholder / not a file
  try {
    const dest = join(workDir, "cookies.txt");
    await fs.copyFile(COOKIES_PATH, dest);
    return ["--cookies", dest];
  } catch (e) {
    // The file is present and non-empty but we couldn't read it — almost always
    // host perms not allowing the container's node user. Warn loudly: otherwise
    // this silently degrades to a no-cookies run that looks like a bot block.
    console.error(`[yt-convert] cookies at ${COOKIES_PATH} present but unreadable; running without them:`, e);
    return [];
  }
}

async function runJob(jobId: string) {
  const [job] = await db.select().from(conversionJobs).where(eq(conversionJobs.id, jobId)).limit(1);
  if (!job || job.status !== "pending") return;

  console.log(`[yt-convert] job ${jobId} starting: ${job.url} (user ${job.userId})`);
  await db
    .update(conversionJobs)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(conversionJobs.id, jobId));

  const settings = await getAppSettings();
  const yt = await getYtConfigForUser(job.userId);
  if (!yt.enabled) return fail(jobId, "YouTube import is disabled");
  if (!hostAllowed(job.url, parseAllowedHosts(settings.ytAllowedHosts))) {
    return fail(jobId, "This link isn't from an allowed site");
  }

  const [owner] = await db
    .select({ discordId: users.discordId })
    .from(users)
    .where(eq(users.id, job.userId))
    .limit(1);
  if (!owner?.discordId) return fail(jobId, "Account isn't set up for uploads");

  const limits = await getUserLimits(job.userId);
  const maxBytes = Math.min(limits.maxFileSize, yt.maxFileSize);

  let workDir: string | null = null;
  try {
    workDir = await fs.mkdtemp(join(tmpdir(), "ytconv-"));
    // %(title).100B → title truncated to 100 bytes; gives us a sensible default
    // clip name from the produced filename without a second yt-dlp call.
    const outTemplate = join(workDir, "%(title).100B.%(ext)s");

    if (cancelledJobs.has(jobId)) return; // cancelled before the download started

    await runYtDlp(jobId, [
      "--ignore-config",
      ...(await cookieArgs(workDir)),
      ...(PROXY ? ["--proxy", PROXY] : []),
      ...(EXTRACTOR_ARGS ? ["--extractor-args", EXTRACTOR_ARGS] : []),
      "--no-playlist",
      "--no-progress",
      "--no-warnings",
      "--quiet",
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "mp3",
      "--download-sections",
      `*0-${yt.maxDurationSec}`,
      "--force-keyframes-at-cuts",
      "--max-filesize",
      String(maxBytes),
      "-o",
      outTemplate,
      job.url,
    ]);

    // Cancelled mid-download (the kill above rejects runYtDlp into the catch, but
    // guard here too for the queued/finished races) — bail before persisting.
    if (cancelledJobs.has(jobId)) return;

    // Find the produced mp3 (filename embeds the video title).
    const files = (await fs.readdir(workDir)).filter((f) => f.toLowerCase().endsWith(".mp3"));
    if (files.length === 0) {
      return fail(jobId, "Couldn't extract audio (clip may be too large or unavailable)");
    }
    const producedName = files[0];
    const buf = await fs.readFile(join(workDir, producedName));

    if (!looksLikeMp3(buf)) return fail(jobId, "Converted file wasn't valid audio");
    if (buf.length > maxBytes) return fail(jobId, "Clip is larger than the allowed size");

    const used = await getUsedBytes(job.userId);
    if (used + buf.length > limits.maxTotalStorage) {
      return fail(jobId, "This would exceed your total storage");
    }

    // Default the clip name to the video title (from the filename), validated.
    const titleGuess = producedName.replace(/\.mp3$/i, "");
    const nameParsed = soundName.safeParse(job.requestedName?.trim() || titleGuess);
    const name = nameParsed.success ? nameParsed.data : "YouTube clip";
    const origParsed = soundName.safeParse(producedName);

    // Tags collected on the import form (JSON array); persistSound normalizes/caps
    // them (and still falls back to `misc` only if none survive).
    let tags: string[] | undefined;
    if (job.requestedTags) {
      try {
        const arr = JSON.parse(job.requestedTags);
        if (Array.isArray(arr)) tags = arr.map(String);
      } catch {
        /* ignore malformed tags */
      }
    }

    const sound = await persistSound({
      ownerId: job.userId,
      discordId: owner.discordId,
      name,
      originalFilename: origParsed.success ? origParsed.data : "youtube.mp3",
      buf,
      isPublic: job.isPublic,
      tags,
    });

    // Cancelled between persist and the done-update — undo the just-created sound
    // (cancelConversion couldn't see the soundId yet) and bail.
    if (cancelledJobs.has(jobId)) {
      await db.delete(sounds).where(eq(sounds.id, sound.id));
      await deleteStorageFile(sound.storagePath).catch(() => {});
      return;
    }

    await db
      .update(conversionJobs)
      .set({ status: "done", soundId: sound.id, error: null, updatedAt: new Date() })
      .where(eq(conversionJobs.id, jobId));
    console.log(`[yt-convert] job ${jobId} done: sound ${sound.id} (${buf.length} bytes)`);
  } catch (e) {
    // A cancel killed the yt-dlp child → runYtDlp rejects here; the status was
    // already set by cancelConversion, so don't overwrite it with a fake error.
    if (cancelledJobs.has(jobId)) return;
    // Log the raw cause (incl. yt-dlp stderr) to the server console / docker
    // logs, with proxy creds redacted; the client only ever sees the short
    // safeError() summary.
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[yt-convert] job ${jobId} (${job.url}) failed:`, redactSecrets(detail));
    await fail(jobId, safeError(e));
  } finally {
    running.delete(jobId);
    cancelledJobs.delete(jobId);
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runYtDlp(jobId: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      YTDLP,
      args,
      { timeout: JOB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        running.delete(jobId);
        if (err) {
          // Attach yt-dlp's own stderr so the catch can log why it failed.
          if (stderr) err.message = `${err.message}\n${stderr}`.trim();
          reject(err);
        } else {
          resolve();
        }
      }
    );
    // Track the child so cancelConversion() can kill it mid-download.
    running.set(jobId, child);
  });
}

// Strip basic-auth creds (e.g. proxy user:pass@host) from text before logging,
// since the failed command — which includes --proxy — gets logged verbatim.
function redactSecrets(s: string): string {
  return s.replace(/\/\/[^/@\s]+@/g, "//***@");
}

// Map raw spawn/yt-dlp failures to short, user-facing messages for the client.
// yt-dlp's own stderr is appended to the error message (see runYtDlp), so match
// the common, actionable cases; the client never sees the raw text.
function safeError(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { killed?: boolean; signal?: string; message?: string };
  if (err?.code === "ENOENT") return "Conversion tool isn't installed on the server";
  if (err?.killed || err?.signal === "SIGTERM") {
    return "Conversion timed out — the video may be too long or the source too slow";
  }

  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("drm")) return "This video is DRM-protected and can't be converted";
  if (msg.includes("not a bot") || msg.includes("sign in to confirm")) {
    return "YouTube is temporarily blocking conversions on the server — please try again later";
  }
  if (msg.includes("private video")) return "This video is private";
  if (msg.includes("members-only") || msg.includes("join this channel")) {
    return "This video is for channel members only";
  }
  if (msg.includes("age") && (msg.includes("restrict") || msg.includes("confirm your age"))) {
    return "This video is age-restricted and can't be converted";
  }
  if (msg.includes("not available in your country") || msg.includes("blocked it in your country")) {
    return "This video isn't available in the server's region";
  }
  if (msg.includes("video unavailable") || msg.includes("no longer available") || msg.includes("has been removed")) {
    return "This video is unavailable";
  }
  if (msg.includes("is live") || msg.includes("live event") || msg.includes("premieres in")) {
    return "Live streams can't be converted";
  }
  if (msg.includes("requested format is not available") || msg.includes("requested format")) {
    return "Couldn't find a downloadable audio track for this video";
  }
  return "Conversion failed — the video may be unavailable or restricted";
}
