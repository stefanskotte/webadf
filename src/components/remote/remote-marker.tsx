import { remoteMarkerText, remoteStatusLook, type RemoteLibraryStatus } from '@/lib/remote/copy';
import { StatusChip } from '@/components/ui/status-chip';

/**
 * "Remote · <name>" (library sharing spec §4.5), on every remote page: what is shown here is someone else's library,
 * read through this server, and nothing on it can be edited. A blue-tinted pill with a two-screens glyph.
 */
export function RemoteMarker({ name }: { name: string }) {
  return (
    <span data-testid="remote-marker"
          className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold"
          style={{ background: 'color-mix(in srgb, var(--accent-blue) 12%, var(--surface))', color: 'var(--accent-blue)', overflowWrap: 'anywhere' }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="2" y="4" width="13" height="10" rx="2" /><rect x="9" y="10" width="13" height="10" rx="2" />
      </svg>
      {remoteMarkerText(name)}
    </span>
  );
}

/** The library's status in words (spec §4.3), always drawn: "Connected" is a reading too. */
export function RemoteStatus({ status, host, lastError }: {
  status: RemoteLibraryStatus; host: string; lastError: string | null;
}) {
  const look = remoteStatusLook(status, host, lastError);
  return (
    <span data-testid="remote-status" data-status={status}>
      <StatusChip kind={look.kind}>{look.label}</StatusChip>
    </span>
  );
}
