import { notFound } from 'next/navigation';
import { requireOrg } from '@/lib/session';
import { remotePaths } from '@/lib/remote/http';
import { loadRemote, remoteLibrary } from '@/lib/remote/pages';
import { checkLibrary, checkTitlesPage } from '@/lib/remote/wire';
import { REMOTE_PAGE_SIZE, remoteHref, remoteView } from '@/lib/remote/view';
import { PageHeader } from '@/components/shell/page-header';
import { RemoteMarker, RemoteStatus } from '@/components/remote/remote-marker';
import { RemoteCollections } from '@/components/remote/remote-collections';
import { RemoteTitleGrid } from '@/components/remote/remote-title-grid';
import { RemoteTitleTable } from '@/components/remote/remote-title-table';
import { RemotePager } from '@/components/remote/remote-pager';
import { RemoteProblem } from '@/components/remote/remote-problem';
import { RemoteSearch, RemoteViewToggle } from '@/components/remote/remote-search';
import { RemoveRemote } from '@/components/remote/remove-remote';

export const dynamic = 'force-dynamic';
// The owner may take its full 10 s per listing (two run side by side); the app's usual ceiling.
export const maxDuration = 60;

/**
 * A remote library (library sharing spec §4.5): the local library's parts, read-only -- the collections in scope, the
 * titles as cards or a table, a search scoped to this library, a pager. Everything comes from the owner through this
 * server (60 s cache). An ended library shows "Access ended" with only Remove (spec §4.3).
 */
export default async function RemoteLibraryPage(props: PageProps<'/remote/[id]'>) {
  const { orgId } = await requireOrg();
  const { id } = await props.params;
  const lib = await remoteLibrary(orgId, id);
  if (!lib) notFound();
  const view = remoteView(await props.searchParams);

  const titlesQuery = new URLSearchParams();
  if (view.collection) titlesQuery.set('collection', view.collection);
  if (view.q) titlesQuery.set('q', view.q);
  if (view.cursor) titlesQuery.set('cursor', view.cursor);
  titlesQuery.set('limit', String(REMOTE_PAGE_SIZE));

  const [library, titles] = lib.status === 'ended'
    ? [null, null]
    : await Promise.all([
      loadRemote(orgId, id, remotePaths.library(), checkLibrary),
      loadRemote(orgId, id, remotePaths.titles(titlesQuery), checkTitlesPage),
    ]);
  // The calls can end the library (a 401): what they left in the database is the status to show.
  const now = lib.status === 'ended' ? lib : await remoteLibrary(orgId, id);
  const status = now?.status ?? 'ended';
  const failure = status === 'ended' ? { failure: 'ended' as const, detail: undefined }
    : library && !library.ok ? library : null;

  const here = remoteHref(id, view);
  const header = (
    <PageHeader
      size="lg"
      eyebrow={[{ label: 'Remote', href: '/remote' }]}
      title={lib.name}
      subtitle={library?.ok
        ? `${library.value.titles.toLocaleString('en-US')} ${library.value.titles === 1 ? 'title' : 'titles'} · ${library.value.disks.toLocaleString('en-US')} ${library.value.disks === 1 ? 'disk' : 'disks'}`
        : undefined}
      actions={failure ? undefined : (
        <div className="flex flex-wrap items-center gap-3">
          <RemoteSearch libraryId={id} view={view} />
          <RemoteViewToggle libraryId={id} view={view} />
          <RemoveRemote id={id} name={lib.name} />
        </div>
      )}
    />
  );
  const marker = (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-4 sm:px-7">
      <RemoteMarker name={lib.name} />
      <span className="font-mono text-[12.5px]" style={{ color: 'var(--muted)' }}>{lib.host}</span>
      <RemoteStatus status={status} host={lib.host} lastError={now?.lastError ?? null} />
    </div>
  );

  if (failure || !library?.ok) {
    const f = failure ?? { failure: 'protocol', detail: undefined };
    return (
      <>
        {header}
        {marker}
        <RemoteProblem libraryId={id} name={lib.name} host={lib.host} failure={f.failure} detail={f.detail} retryHref={here} />
      </>
    );
  }

  const list = titles?.ok ? titles.value : null;
  const nextHref = list?.nextCursor ? remoteHref(id, { ...view, cursor: list.nextCursor }) : null;
  const firstHref = view.cursor ? remoteHref(id, { ...view, cursor: null }) : null;
  return (
    <>
      {header}
      {marker}
      <div className="flex flex-col gap-4 pb-10 md:flex-row md:items-start">
        <RemoteCollections libraryId={id} library={library.value} view={view} />
        <div className="min-w-0 flex-1">
          {titles && !titles.ok ? (
            <RemoteProblem libraryId={id} name={lib.name} host={lib.host} failure={titles.failure} detail={titles.detail}
                           retryHref={here} />
          ) : list && list.titles.length === 0 ? (
            <p data-testid="remote-titles-empty" className="mx-4 text-[14px] sm:mx-7" style={{ color: 'var(--muted)' }}>
              {view.q ? `No titles match "${view.q}".` : 'Nothing is shared here yet.'}
            </p>
          ) : list && view.view === 'table' ? (
            <RemoteTitleTable libraryId={id} titles={list.titles} />
          ) : list ? (
            <RemoteTitleGrid libraryId={id} titles={list.titles} />
          ) : null}
          <RemotePager firstHref={firstHref} nextHref={nextHref} />
        </div>
      </div>
    </>
  );
}
