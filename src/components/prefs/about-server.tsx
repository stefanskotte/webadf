import { Suspense } from 'react';
import { buildInfo } from '@/lib/about/build-info';
import { hostingMode } from '@/lib/about/hosting';
import { libraryUsage } from '@/lib/about/library-usage';
import { firmwareSummary } from '@/lib/about/firmware-summary';
import { settle } from '@/lib/about/settle';
import { storageLabel } from '@/lib/storage';
import { AboutBone, AboutCard, AboutGroupsView } from './about-view';

/** The groups' reads, moved from the old /about page: each settles on its own, so one failing read blanks only its group. */
async function AboutGroups({ orgId }: { orgId: string }) {
  const [usage, firmware] = await Promise.all([settle(libraryUsage(orgId)), settle(firmwareSummary(orgId))]);
  return (
    <AboutGroupsView build={buildInfo()} hosted={hostingMode() === 'hosted'} node={process.versions.node}
                     storage={storageLabel()} usage={usage} firmware={firmware} />
  );
}

/**
 * Settings > About this server (C7 spec §10, Rulings 21-24): the card renders with Settings, and its groups stream in
 * their own Suspense, so the account cards never wait for libraryUsage's blob sum.
 */
export function AboutServer({ orgId }: { orgId: string }) {
  return (
    <AboutCard>
      <Suspense fallback={<AboutBone />}>
        <AboutGroups orgId={orgId} />
      </Suspense>
    </AboutCard>
  );
}
