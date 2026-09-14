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
  ],
};
