import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { tags, soundTags } from "@/db/schema";

// Tags are global + normalized: one lowercase label is one shared `tag` row
// across every clip, so the admin can rename/delete it everywhere at once. The
// app caps a clip at MAX_TAGS_PER_SOUND; see web/src/db/schema.ts.
export const MAX_TAGS_PER_SOUND = 3;
const MAX_TAG_LEN = 30;

// Lowercase, trim, collapse internal whitespace. Returns null when the result
// is empty, too long, or has characters we don't allow. Tags stay deliberately
// simple — letters, digits, spaces, hyphens — so they read cleanly as chips and
// are easy to type and autocomplete.
export function normalizeTag(raw: string): string | null {
  const t = raw.toLowerCase().trim().replace(/\s+/g, " ");
  if (!t || t.length > MAX_TAG_LEN) return null;
  if (!/^[a-z0-9][a-z0-9 -]*$/.test(t)) return null;
  return t;
}

// Normalize a list, drop invalid + duplicate entries, cap at the per-sound max.
export function normalizeTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const t = normalizeTag(r);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS_PER_SOUND) break;
  }
  return out;
}

// Replace a sound's tags with `names`. Upserts the global tag rows, then
// rewrites this sound's join rows — all in one transaction so a clip never ends
// up with a half-applied tag set.
export async function setSoundTags(soundId: string, names: string[]): Promise<void> {
  const clean = normalizeTags(names);
  await db.transaction(async (tx) => {
    let tagIds: string[] = [];
    if (clean.length) {
      await tx.insert(tags).values(clean.map((name) => ({ name }))).onConflictDoNothing();
      const rows = await tx.select({ id: tags.id }).from(tags).where(inArray(tags.name, clean));
      tagIds = rows.map((r) => r.id);
    }
    await tx.delete(soundTags).where(eq(soundTags.soundId, soundId));
    if (tagIds.length) {
      await tx
        .insert(soundTags)
        .values(tagIds.map((tagId) => ({ soundId, tagId })))
        .onConflictDoNothing();
    }
  });
}

// Tag names for a batch of sounds, keyed by soundId (sorted alphabetically).
// Used to decorate the board / public / admin listings in one extra query.
export async function getTagsForSounds(soundIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!soundIds.length) return map;
  const rows = await db
    .select({ soundId: soundTags.soundId, name: tags.name })
    .from(soundTags)
    .innerJoin(tags, eq(tags.id, soundTags.tagId))
    .where(inArray(soundTags.soundId, soundIds))
    .orderBy(tags.name);
  for (const r of rows) {
    const arr = map.get(r.soundId) ?? [];
    arr.push(r.name);
    map.set(r.soundId, arr);
  }
  return map;
}

// Every tag name in the system, sorted — feeds the dashboard tag autocomplete.
export async function listAllTagNames(): Promise<string[]> {
  const rows = await db.select({ name: tags.name }).from(tags).orderBy(tags.name);
  return rows.map((r) => r.name);
}

// --- Admin tag management ---

// All tags with how many clips use each — drives the admin tag table.
export async function listTagsWithCounts(): Promise<{ id: string; name: string; count: number }[]> {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      count: sql<number>`count(${soundTags.soundId})`.mapWith(Number),
    })
    .from(tags)
    .leftJoin(soundTags, eq(soundTags.tagId, tags.id))
    .groupBy(tags.id)
    .orderBy(tags.name);
}

// Rename a tag globally (affects every clip using it). If the new name already
// belongs to a different tag, the two are merged: this tag's clips are repointed
// at the surviving tag (deduped) and this tag is deleted.
export async function renameTag(id: string, rawName: string): Promise<{ ok: boolean; error?: string }> {
  const name = normalizeTag(rawName);
  if (!name) return { ok: false, error: "invalid tag name" };

  const [existing] = await db.select({ id: tags.id }).from(tags).where(eq(tags.name, name)).limit(1);
  if (existing && existing.id !== id) {
    await db.transaction(async (tx) => {
      const rows = await tx.select({ soundId: soundTags.soundId }).from(soundTags).where(eq(soundTags.tagId, id));
      if (rows.length) {
        await tx
          .insert(soundTags)
          .values(rows.map((r) => ({ soundId: r.soundId, tagId: existing.id })))
          .onConflictDoNothing();
      }
      await tx.delete(tags).where(eq(tags.id, id)); // FK cascade drops old join rows
    });
    return { ok: true };
  }

  await db.update(tags).set({ name }).where(eq(tags.id, id));
  return { ok: true };
}

// Delete a tag globally; the soundTag FK cascade removes it from every clip.
export async function deleteTag(id: string): Promise<void> {
  await db.delete(tags).where(eq(tags.id, id));
}
