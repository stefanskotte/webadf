import { relative } from '@/lib/device-state';

/** The slice of the single demozoo_import row the admin status line needs. */
export interface DemozooStatusRow {
  step: string;
  appliedAt: Date | null;
  lastAttemptAt: Date | null;
  fetchedAt: Date | null;
  productionsWritten: number;
  screenshotsWritten: number;
}

/**
 * null = no row (never fetched); 'unreadable' = the read failed. Kept apart
 * on purpose: a missing table must not read as "never fetched".
 */
export function demozooStatusText(state: DemozooStatusRow | null | 'unreadable', now: number): string {
  if (state === 'unreadable') return 'Demozoo: unreadable';
  if (!state) return 'Demozoo: never fetched';
  if (state.appliedAt) {
    return `Demozoo: applied ${relative(state.appliedAt, now)} · ${state.productionsWritten} productions · `
      + `${state.screenshotsWritten} screenshots · last checked ${relative(state.lastAttemptAt, now)}`;
  }
  if (!state.fetchedAt) return 'Demozoo: never fetched';
  return `Demozoo: fetched ${relative(state.fetchedAt, now)}, not applied yet`;
}
