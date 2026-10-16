import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  crons: [
    // Nightly. The sweep is resumable and idempotent, so a run that does not
    // finish simply continues on the next one; there is no need for a tight
    // schedule to "catch up".
    { path: '/api/cron/scan', schedule: '0 3 * * *' },
    // Daily, but it asks Demozoo at most once a week (operator ruling,
    // 2026-09-14); the other days resume an unfinished import from our copy.
    // Before the nightly scan's next run, so fresh productions are matched.
    { path: '/api/cron/demozoo', schedule: '30 1 * * *' },
    // Weekly, Sunday 04:00 UTC (operator ruling, 2026-10-08): reclaim blobs and
    // store objects nothing references any more (src/lib/blob-gc.ts). After the
    // nightly scan, so a run never races it for the same rows.
    { path: '/api/cron/blob-gc', schedule: '0 4 * * 0' },
    // Daily 02:15 UTC (self-hosting P3 D1-D3): imports firmware releases from GitHub, verified as a board
    // verifies them. On our own deployment it finds every release already present and does nothing.
    { path: '/api/cron/firmware-import', schedule: '15 2 * * *' },
    // Monthly, the 2nd at 05:00 UTC (self-hosting P3 D6-D7): imports the newest TOSEC release's Amiga [ADF] DATs from
    // tosecdev.org. After the nightly scan, so the next night's scan matches against the new data.
    { path: '/api/cron/tosec-fetch', schedule: '0 5 2 * *' },
  ],
};
