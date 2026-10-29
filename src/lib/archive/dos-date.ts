/** A DOS date/time (date high, time low): a wall clock with no zone, kept as that UTC instant (increment 2 R10). */
export function dosDateTime(v: number): Date | null {
  const d = v >>> 16, t = v & 0xffff;
  const year = 1980 + (d >> 9), month = (d >> 5) & 15, day = d & 31;
  const h = t >> 11, m = (t >> 5) & 63, s = (t & 31) * 2;
  if (!month || month > 12 || !day || h > 23 || m > 59 || s > 59) return null;
  // Date.UTC rolls an impossible day over (Feb 30 -> Mar 2); such a date is no date.
  const at = new Date(Date.UTC(year, month - 1, day, h, m, s));
  return at.getUTCDate() === day ? at : null;
}
