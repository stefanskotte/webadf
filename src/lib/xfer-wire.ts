/**
 * The `xfer` object of the poll body (PaulaNET Phase 4): the send queue's cursor `v`, and the Amiga's last address
 * `ip` (plan 2026-10-17 R17), which 1.16.0 seeds its sorter with after a reboot. Boards 1.14.0 and 1.15.0 copy it
 * into a 48-byte buffer and ignore `ip`; the worst object is 40 bytes (device-limits.test.ts measures this output).
 * `ip` is absent when none was ever heard.
 */
export function buildXfer(v: number, ip: string | null): { v: number; ip?: string } {
  return ip ? { v, ip } : { v };
}

/** The `req` object of the poll body (NET: volumes, spec 2026-10-30 §3): the request queue's cursor. */
export function buildReq(v: number): { v: number } {
  return { v };
}
