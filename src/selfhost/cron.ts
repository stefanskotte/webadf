/** Self-hosting P2 (spec D11): the subset of cron vercel.ts uses -- numbers, '*', comma lists; UTC. */
export interface Cron { minute: number[]; hour: number[]; dom: number[] | null; month: number[] | null; dow: number[] | null }

function field(s: string, lo: number, hi: number): number[] | null {
  if (s === '*') return null;
  if (!/^\d+(,\d+)*$/.test(s)) throw new Error(`unsupported cron field "${s}"`);
  const v = s.split(',').map(Number);
  if (v.some((n) => n < lo || n > hi)) throw new Error(`cron field "${s}" out of range ${lo}-${hi}`);
  return v;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron "${expr}" must have 5 fields`);
  const all = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return {
    minute: field(f[0], 0, 59) ?? all(0, 59),
    hour: field(f[1], 0, 23) ?? all(0, 23),
    dom: field(f[2], 1, 31), month: field(f[3], 1, 12), dow: field(f[4], 0, 6),
  };
}

export function nextRun(c: Cron, after: Date): Date {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if ((c.month === null || c.month.includes(t.getUTCMonth() + 1))
      && (c.dom === null || c.dom.includes(t.getUTCDate()))
      && (c.dow === null || c.dow.includes(t.getUTCDay()))
      && c.hour.includes(t.getUTCHours()) && c.minute.includes(t.getUTCMinutes())) return t;
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  throw new Error('no run within a year');
}

/**
 * When the scheduler arms again after serving slot `served`, at time `now`. From the later of the two: a timer
 * that fired a little early cannot pick the same slot twice, and after a long gap (a suspended host, an overrun)
 * the missed slots collapse into the run just made instead of firing back to back.
 */
export function nextArm(c: Cron, served: Date, now: Date): Date {
  return nextRun(c, new Date(Math.max(served.getTime(), now.getTime())));
}
