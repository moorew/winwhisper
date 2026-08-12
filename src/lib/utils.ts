import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Parses a timestamp from the engine.
 *
 * The engine stores naive UTC (`datetime.utcnow()`), so its ISO strings carry
 * no timezone marker — and ECMAScript parses a bare date-time as *local* time.
 * Without this, every timestamp is wrong by the user's UTC offset. Appending
 * "Z" pins it to UTC; strings that already carry an offset are left alone.
 */
export function parseEngineDate(dateStr: string): Date {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(dateStr.trim());
  return new Date(hasZone ? dateStr : `${dateStr}Z`);
}

export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - parseEngineDate(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * How long a job has been running, as "3m 20s". Shown next to the progress bar
 * so a slow model is visibly making progress rather than looking frozen.
 */
export function formatElapsed(since: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - parseEngineDate(since).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Strips characters Windows forbids in filenames. Transcript titles come from
 * source filenames and YouTube video titles, which routinely contain ":" and
 * "|" — leaving those in makes the save silently fail.
 */
export function safeFilename(name: string, fallback = "transcript"): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    // Windows also rejects names ending in a dot or a space.
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, 120)
    .trim();
  // CON, PRN, AUX, NUL, COM1-9 and LPT1-9 are reserved device names on Windows.
  if (!cleaned || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}
