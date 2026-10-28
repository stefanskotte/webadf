import { Link } from '@/components/shell/link';
import { remoteErrorText } from '@/lib/remote/copy';
import { RemoveRemote } from './remove-remote';

/**
 * When the owner did not answer with a listing (spec §4.3): the reason in words, and the ways on. An ended library
 * ("Access ended") offers only Remove; anything else offers trying again and going back to the list.
 */
export function RemoteProblem({ libraryId, name, host, failure, detail, retryHref }: {
  libraryId: string; name: string; host: string; failure: string; detail?: string; retryHref: string;
}) {
  const ended = failure === 'ended';
  const text = remoteErrorText(failure, host, detail);
  const why = ended
    ? `${name} is no longer shared with you. Copies of its disks were taken out of your drives; disks you saved to stay in your library.`
    : failure === 'not_found' || failure === 'not_shared'
      ? 'The owner no longer shares this. It may have been taken out of a shared collection.'
      : failure === 'unreachable'
        ? `${host} did not answer. It may be switched off or offline; try again later.`
        : failure === 'protocol'
          ? 'The two WebFloppy servers speak different versions of sharing. Updating the older one fixes it.'
          : 'Nothing was changed.';
  return (
    <div data-testid={ended ? 'remote-ended' : 'remote-problem'} data-failure={failure} role="alert"
         className="mx-4 flex max-w-[560px] flex-col gap-3 p-6 sm:mx-7"
         style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 20 }}>
      <h2 className="text-[20px] font-bold leading-tight" style={{ color: 'var(--ink)', fontFamily: 'var(--font-display)' }}>
        {text}
      </h2>
      <p className="text-[14px] leading-relaxed" style={{ color: 'var(--muted)' }}>{why}</p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {ended ? (
          <RemoveRemote id={libraryId} name={name} testId="remote-ended-remove" />
        ) : (
          <>
            <Link href={retryHref} data-testid="remote-retry"
                  className="btn-like inline-flex h-9 items-center rounded-[9px] px-3.5 text-[13px] font-semibold text-white max-sm:min-h-11"
                  style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
              Try again
            </Link>
            <Link href="/remote" className="text-[13.5px] font-semibold underline-offset-4 hover:underline" style={{ color: 'var(--primary-action)' }}>
              All remote libraries
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
