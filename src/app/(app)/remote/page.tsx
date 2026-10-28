import { requireOrg } from '@/lib/session';
import { listRemoteLibraries } from '@/lib/remote/store';
import { hostOf } from '@/lib/remote/http';
import { cardSummary } from '@/lib/remote/pages';
import { PageHeader } from '@/components/shell/page-header';
import { Link } from '@/components/shell/link';
import { RemoteLibraryCard } from '@/components/remote/remote-library-card';

export const metadata = { title: 'Remote' };
export const dynamic = 'force-dynamic';

const ADD_BTN = 'btn-like inline-flex h-10 items-center rounded-[10px] px-4 text-[14px] font-semibold text-white max-sm:min-h-11';

/**
 * Remote (library sharing spec §4.5): the libraries other WebFloppy owners shared with this team, one card each. Empty,
 * it says what a remote library is and offers Add. Each card asks its owner for the collections (cached 60 s),
 * streamed in; an ended library is not asked again.
 */
export default async function RemotePage() {
  const { orgId } = await requireOrg();
  const libs = await listRemoteLibraries(orgId);
  const add = (
    <Link href="/remote/add" data-testid="remote-add" className={ADD_BTN} style={{ background: 'var(--primary-action)' }}>
      Add a shared library
    </Link>
  );
  return (
    <>
      <PageHeader size="lg" eyebrow="Shared with you" title="Remote"
                  subtitle={libs.length > 0 ? `${libs.length} ${libs.length === 1 ? 'library' : 'libraries'}` : undefined}
                  actions={libs.length > 0 ? add : undefined} />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7" data-testid="remote-list">
        {libs.length === 0 ? (
          <div data-testid="remote-empty" className="glass-card flex max-w-[640px] flex-col gap-3 p-6">
            <h2 className="text-[19px] font-bold" style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>
              No remote libraries yet
            </h2>
            <p className="text-[14px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              Another WebFloppy owner can share their library, or some of its collections, with you. They send you a
              link; add it here and their titles appear under Remote. You can browse them, mount their disks in your
              drives, send them to your Amiga and download them. Their library stays theirs: when you save to one of their
              disks, that disk becomes a copy in your own library.
            </p>
            <div>{add}</div>
          </div>
        ) : libs.map((l) => (
          <RemoteLibraryCard key={l.id}
                             lib={{ id: l.id, name: l.name, host: hostOf(l.baseUrl), status: l.status, lastOkAt: l.lastOkAt, lastError: l.lastError }}
                             summary={l.status === 'ended' ? null : cardSummary(orgId, l.id)} />
        ))}
      </div>
    </>
  );
}
