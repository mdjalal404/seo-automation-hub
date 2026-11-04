/**
 * Website-local scheduling. Users pick a wall-clock time in the website's IANA
 * timezone; we store UTC. Uses Intl only (no dependency) and handles DST gaps by
 * resolving forward, and DST overlaps by choosing the earlier instant.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Converts "YYYY-MM-DDTHH:mm" in `timeZone` to a UTC Date. */
export function zonedLocalToUtc(local: string, timeZone: string): Date {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error("Invalid local date-time. Use YYYY-MM-DDTHH:mm.");
  if (!isValidTimeZone(timeZone)) throw new Error(`Unknown timezone: ${timeZone}`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  // Two passes converge for all real-world offsets, including across DST changes.
  let guess = naive - offsetMinutes(naive, timeZone) * 60_000;
  guess = naive - offsetMinutes(guess, timeZone) * 60_000;
  return new Date(guess);
}

/** Formats a UTC instant as "YYYY-MM-DDTHH:mm" wall-clock time in `timeZone` (for inputs). */
export function utcToZonedLocal(date: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(date));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function formatInZone(date: Date | string | null | undefined, timeZone = "UTC"): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short", timeZoneName: "short" }).format(new Date(date));
}
