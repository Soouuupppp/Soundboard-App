import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { sounds, boardEntries } from "@/db/schema";
import { ensureUserDir } from "@/lib/storage";

// Sniff magic bytes — accept ID3 ("ID3") or an MPEG audio sync word
// (0xFF + 0xEx/Fx). Trims leading null padding some encoders add. Shared by the
// upload route and the YouTube conversion worker, which both produce mp3 bytes
// from an untrusted source.
export function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  // ID3v2 tag header.
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  // MPEG audio sync: 11 high bits set → first byte 0xFF, second byte top 3 bits set.
  // Scan past up to 1KiB of leading zero padding some tools insert.
  for (let i = 0; i < Math.min(buf.length - 1, 1024); i++) {
    if (buf[i] === 0x00) continue;
    return buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0;
  }
  return false;
}

// Writes an mp3 to the owner's storage dir, records the `sound` row, and
// auto-adds it to the owner's board — the common tail of every way a clip
// enters the system (direct upload or YouTube import). Callers are responsible
// for auth, quota, and mp3 validation before calling this.
export async function persistSound(opts: {
  ownerId: string;
  discordId: string;
  name: string;
  originalFilename: string;
  buf: Buffer;
  isPublic: boolean;
}) {
  const dir = await ensureUserDir(opts.discordId);
  const id = randomUUID();
  const storageRel = `${opts.discordId}/${id}.mp3`;
  const abs = join(dir, `${id}.mp3`);
  await fs.writeFile(abs, opts.buf);

  const [row] = await db
    .insert(sounds)
    .values({
      id,
      ownerId: opts.ownerId,
      name: opts.name,
      originalFilename: opts.originalFilename,
      storagePath: storageRel,
      sizeBytes: opts.buf.length,
      isPublic: opts.isPublic,
    })
    .returning();

  // Auto-add to the owner's own board.
  await db.insert(boardEntries).values({
    userId: opts.ownerId,
    soundId: row.id,
  });

  return row;
}
