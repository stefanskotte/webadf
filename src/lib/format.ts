/**
 * Renderings that must read the same everywhere.
 *
 * Both of these were module-private in the component that first needed them
 * and then re-implemented, slightly differently, in the next one -- which is
 * how a .uf2 came to be shown as "1465 KB" on one page while every other size
 * in the product said "1.43 MB", and how a release timestamp lost the UTC
 * marker that the disk history carries for exactly the same reason.
 */

/** Bytes for humans. Switches to MB above 1,000,000 so a firmware image reads sanely. */
export function fmtSize(bytes: number): string {
  return bytes >= 1_000_000
    ? `${(bytes / 1_048_576).toFixed(2)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * A timestamp, fixed to UTC and SAYING so.
 *
 * Server and client must read the identical string for the identical Date, so
 * this cannot use a locale. The marker is not decoration: a list ordered by
 * time is exactly where "which one happened first" has to be unambiguous, and
 * an unlabelled 14:32 is two hours wrong to a reader in Copenhagen.
 */
export function fmtTimeUtc(d: Date): string {
  const iso = d.toISOString(); // 2026-09-21T14:32:07.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
