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

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversionJobs, users } from "@/db/schema";
import { getAppSettings, parseAllowedHosts } from "@/lib/app-settings";
import { getUserLimits, getUsedBytes } from "@/lib/quota";
import { looksLikeMp3, persistSound } from "@/lib/sounds";
import { soundName } from "@/lib/validation";

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Hard wall-clock ceiling per job so a stuck download can't hold a slot forever.
const JOB_TIMEOUT_MS = 180_000;

const queue: string[] = [];
let active = 0;

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

export function enqueueConversion(jobId: string) {
  queue.push(jobId);
  void pump();
}

async function pump() {
  // Re-read concurrency each tick so admin changes take effect for new jobs.
  const { ytConcurrency } = await getAppSettings();
  while (active < ytConcurrency && queue.length > 0) {
    const jobId = queue.shift()!;
    active++;
    void runJob(jobId).finally(() => {
      active--;
      void pump();
    });
  }
}

async function fail(jobId: string, message: string) {
  await db
    .update(conversionJobs)
    .set({ status: "error", error: message, updatedAt: new Date() })
    .where(eq(conversionJobs.id, jobId));
}

async function runJob(jobId: string) {
  const [job] = await db.select().from(conversionJobs).where(eq(conversionJobs.id, jobId)).limit(1);
  if (!job || job.status !== "pending") return;

  await db
    .update(conversionJobs)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(conversionJobs.id, jobId));

  const settings = await getAppSettings();
  if (!settings.ytEnabled) return fail(jobId, "YouTube import is disabled");
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
  const maxBytes = Math.min(limits.maxFileSize, settings.ytMaxFileSize);

  let workDir: string | null = null;
  try {
    workDir = await fs.mkdtemp(join(tmpdir(), "ytconv-"));
    // %(title).100B → title truncated to 100 bytes; gives us a sensible default
    // clip name from the produced filename without a second yt-dlp call.
    const outTemplate = join(workDir, "%(title).100B.%(ext)s");

    await runYtDlp([
      "--ignore-config",
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
      `*0-${settings.ytMaxDurationSec}`,
      "--force-keyframes-at-cuts",
      "--max-filesize",
      String(maxBytes),
      "-o",
      outTemplate,
      job.url,
    ]);

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

    const sound = await persistSound({
      ownerId: job.userId,
      discordId: owner.discordId,
      name,
      originalFilename: origParsed.success ? origParsed.data : "youtube.mp3",
      buf,
      isPublic: job.isPublic,
    });

    await db
      .update(conversionJobs)
      .set({ status: "done", soundId: sound.id, error: null, updatedAt: new Date() })
      .where(eq(conversionJobs.id, jobId));
  } catch (e) {
    // Log the raw cause (incl. yt-dlp stderr) to the server console / docker
    // logs; the client only ever sees the short safeError() summary.
    console.error(`[yt-convert] job ${jobId} (${job.url}) failed:`, e);
    await fail(jobId, safeError(e));
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runYtDlp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      args,
      { timeout: JOB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          // Attach yt-dlp's own stderr so the catch can log why it failed.
          if (stderr) err.message = `${err.message}\n${stderr}`.trim();
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

// Map raw spawn/yt-dlp failures to short, non-leaky messages for the client.
function safeError(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
  if (err?.code === "ENOENT") return "Conversion tool isn't installed on the server";
  if (err?.killed || err?.signal === "SIGTERM") return "Conversion timed out";
  return "Conversion failed";
}
