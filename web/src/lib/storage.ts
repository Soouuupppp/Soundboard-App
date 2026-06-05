import { promises as fs } from "node:fs";
import { createReadStream, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const UPLOADS_DIR = process.env.UPLOADS_DIR || "/data_public";

export function userDir(discordId: string) {
  // discordId is a numeric snowflake; harmless to use directly, but enforce shape.
  if (!/^\d{5,30}$/.test(discordId)) throw new Error("Invalid user id");
  return join(UPLOADS_DIR, discordId);
}

export async function ensureUserDir(discordId: string) {
  const dir = userDir(discordId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function resolveStoragePath(relative: string) {
  // Prevent path traversal — must resolve inside UPLOADS_DIR.
  const abs = resolve(UPLOADS_DIR, relative);
  const root = resolve(UPLOADS_DIR);
  if (!abs.startsWith(root + (root.endsWith("/") || root.endsWith("\\") ? "" : "/")) && abs !== root) {
    // On Windows the separator differs — do a relaxed check too.
    const rel = abs.slice(root.length).replace(/^[\\/]/, "");
    if (rel.includes("..")) throw new Error("Path traversal blocked");
  }
  return abs;
}

export async function deleteStorageFile(relative: string) {
  const abs = resolveStoragePath(relative);
  await fs.rm(abs, { force: true });
}

export function statStorageFile(relative: string) {
  const abs = resolveStoragePath(relative);
  return statSync(abs);
}

export function openReadStream(relative: string) {
  return createReadStream(resolveStoragePath(relative));
}
