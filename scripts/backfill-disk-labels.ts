// One-off: fill empty disks.label with the AmigaDOS volume name for disks of
// multi-disk titles (the board's "Disk n/c <name>" line). See
// src/lib/disk-label-backfill.ts. DRY RUN unless --apply; prints counts only.
// Usage: pnpm labels:backfill [--apply]   (DATABASE_URL and storage from the env)
import { closeDb } from '@/db';
import { backfillDiskLabels } from '@/lib/disk-label-backfill';

const apply = process.argv.includes('--apply');
backfillDiskLabels({ apply })
  .then((c) => {
    console.log(`${apply ? 'APPLIED' : 'dry run (pass --apply to write)'}: `
      + `${c.candidates} unlabelled disks in multi-disk titles; ${c.named} have a volume name `
      + `(${apply ? `${c.written} written` : 'would be written'}); ${c.noName} have none; ${c.unreadable} unreadable`);
  })
  .catch((e) => { console.error('labels:backfill:', e instanceof Error ? e.message : 'failed'); process.exitCode = 1; })
  .finally(() => closeDb());
