import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const SIZE_UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  k: 1024, kb: 1024, kib: 1024,
  m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
  g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
  t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
};

// Parse human-friendly size like "5 MB", "1.5gb", "500", "2GiB" -> bytes.
// Returns null when the input is unparseable. A bare number is treated as bytes.
export function parseSize(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*([a-z]+)?$/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = (m[2] ?? "").replace(/(yte|ytes)$/, ""); // strip "byte"/"bytes"
  const mult = SIZE_UNITS[unit];
  if (mult == null) return null;
  return Math.round(num * mult);
}
