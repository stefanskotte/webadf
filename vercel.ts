import type { VercelConfig } from '@vercel/config/v1';

export const config: VercelConfig = {
  crons: [
    // Nightly. The sweep is resumable and idempotent, so a run that does not
    // finish simply continues on the next one; there is no need for a tight
    // schedule to "catch up".
    { path: '/api/cron/scan', schedule: '0 3 * * *' },
  ],
};
