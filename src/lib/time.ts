/** Compact relative time labels for sidebar/session lists. */

export function formatRelativeTime(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
