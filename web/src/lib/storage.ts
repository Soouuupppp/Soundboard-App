import { promises as fs } from "node:fs";
import { createReadStream, statSync } from "node:fs";
import { isAbsolute, join, relative as pathRelative, resolve, sep } from "node:path";

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
  // Reject anything that looks absolute up-front (covers `/etc/passwd`, `C:\...`, UNC paths).
  if (!relative || isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative) || relative.startsWith("\\\\")) {
    throw new Error("Path traversal blocked");
  }
  // Turbopack's static tracer can't see through process.env, and would otherwise
  // try to bundle the whole project. UPLOADS_DIR is intentionally runtime-only.
  const root = resolve(/* turbopackIgnore: true */ UPLOADS_DIR);
  const abs = resolve(root, relative);
  // After resolve(), a safe path will be either == root or strictly under it.
  const rel = pathRelative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error("Path traversal blocked");
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
