/**
 * Pure display helpers — no `node:` imports, no fs, safe to use from anywhere.
 *
 * Everything is formatted explicitly rather than through `toLocaleString`: the panel is rendered
 * on the server and shipped as HTML, so a locale-dependent string would silently change with the
 * server's environment. Times are shown in LOCAL time, matching the `YYYYMMDD-HHmmss` stamp the
 * run ids already use (SPEC § Storage).
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-08-22 00:48:47` in local time. Returns the raw string if it is not a parseable date. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** `3 min ago`, `2 h ago`, `yesterday` — the coarse "how fresh is this" line under a card. */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((now.getTime() - then) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/**
 * `6.5s`, `1m 09s`, `420ms` — a duration a human can compare at a glance.
 * Runs here range from a few hundred ms to several minutes, so no unit above minutes is needed.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${pad(Math.round(secs - mins * 60))}s`;
}

/** `12.4 kB`, `1.1 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
