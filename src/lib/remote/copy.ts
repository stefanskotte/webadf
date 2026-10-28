// The recipient's words for remote libraries (library sharing spec §4.2-4.5, global constraints "UI copy"). Pure and
// CLIENT-SAFE: the pages render these on the server, the buttons in the browser, and both must say the same thing.
import type { ChipKind } from '@/lib/send-ui';

/** A remote library's status as stored (remote_libraries.status). */
export type RemoteLibraryStatus = 'ok' | 'unreachable' | 'ended' | 'protocol';

const other = 'the other WebFloppy';
const named = (host: string | null | undefined) => (host && host.trim() ? host.trim() : null);
/** A host as the subject of a sentence; a host is never re-cased, only the fallback words are. */
const subject = (host: string | null | undefined) => named(host) ?? 'The other WebFloppy';

/** "<host> needs a WebFloppy update" or "Your WebFloppy needs an update", from the client's detail (share/client.ts). */
function protocolText(host: string | null | undefined, detail: string | null | undefined): string {
  if (detail === 'local_older') return 'Your WebFloppy needs an update';
  return `${subject(host)} needs a WebFloppy update`;
}

/** A sealed token this server cannot open (BETTER_AUTH_SECRET changed): only a new link helps (final review 3). */
const TOKEN_UNREADABLE = "This shared library can't be opened on this server. Remove it and ask for a new link.";

/**
 * The sentence for an /api/remote/* error code (src/lib/remote/http.ts, src/app/api/remote/route.ts), with the owner's
 * host where the person needs it. A disk action's 404 is "No longer shared" (Review Focus 1); so is a title's: both
 * mean the owner took it out of what they share. Unknown codes never reach the screen as codes.
 */
export function remoteErrorText(
  failure: string | null | undefined, host: string | null | undefined, detail?: string | null,
): string {
  switch (failure) {
    case 'ended': return 'Access ended';
    case 'unreachable': return `Can't reach ${named(host) ?? other}`;
    case 'invalid_or_used': return 'This link was already used, has expired or was revoked';
    case 'protocol': return protocolText(host, detail);
    case 'bad_response': return `${subject(host)} didn't answer like a WebFloppy`;
    case 'token_unreadable': return TOKEN_UNREADABLE;
    case 'not_shared':
    case 'not_found': return 'No longer shared';
    case 'rate_limited': return `${subject(host)} is busy. Try again in a minute.`;
    case 'too_large': return 'That disk is too large to fetch.';
    case 'mismatch': return 'The disk changed while it was being fetched. Try again.';
    case 'bad_link': return "That doesn't look like a share link. Paste the whole link you were sent.";
    case 'no_device': return 'That board cannot receive files.';
    default: return 'Something went wrong. Try again.';
  }
}

/**
 * The status pill (spec §4.3): both values are shown in words (an absent pill is not a reading). `lastError` is the
 * stored "<failure>: <detail>" line; for 'protocol' it says which side is older.
 */
export function remoteStatusLook(
  status: RemoteLibraryStatus, host: string | null | undefined, lastError: string | null | undefined,
): { kind: ChipKind; label: string } {
  // Not a status (the owner may be fine): this server cannot open the token it holds, so every call is refused.
  if (lastError === 'token_unreadable') return { kind: 'red', label: "Can't be opened on this server" };
  switch (status) {
    case 'ok': return { kind: 'green', label: 'Connected' };
    case 'ended': return { kind: 'red', label: 'Access ended' };
    case 'protocol': {
      const detail = lastError?.startsWith('protocol: ') ? lastError.slice('protocol: '.length) : null;
      return { kind: 'amber', label: protocolText(host, detail) };
    }
    default: return { kind: 'amber', label: remoteErrorText('unreachable', host) };
  }
}

/** The marker on every remote page (spec §4.5). */
export function remoteMarkerText(name: string): string {
  return `Remote · ${name}`;
}

// One fixed locale and zone: rendered on the server and read again in the browser (share/view.ts does the same).
const WHEN = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
});

/** "Last answered 28 Oct 2026, 09:05 UTC", or "Never answered". */
export function lastAnsweredText(at: Date | string | null | undefined): string {
  if (!at) return 'Never answered';
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) return 'Never answered';
  return `Last answered ${WHEN.format(d)} UTC`;
}

/**
 * The notice on the person's own copy of a remote title (spec §4.2 First write): "Your copy of <library>'s library",
 * from games.copied_from (the remote library's name when the first write made the copy). Null when it is not a copy.
 */
export function copiedFromText(copiedFrom: string | null | undefined): string | null {
  const name = copiedFrom?.trim();
  return name ? `Your copy of ${name}'s library` : null;
}
