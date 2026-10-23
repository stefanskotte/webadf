'use client';

import { useEffect } from 'react';
import { StateCard, StateLink } from './state-card';

/**
 * What an error.tsx boundary shows (A1 States). `retry` is Next's: it re-fetches the failed segment from the server
 * and renders it again, which is what "Try again" should mean -- `reset` would only re-draw what already failed.
 *
 * The reference is `error.digest`, the id Next prints beside the same error in the server log, so a person quoting
 * it lets us find the failure. An error thrown in the browser has no digest, and then there is no reference line.
 */
export function ErrorView({ error, retry, homeHref, homeLabel }: {
  error: Error & { digest?: string };
  retry: () => void;
  homeHref: string;
  homeLabel: string;
}) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <StateCard
      testId="error-page"
      title="This page didn't load"
      message="Something went wrong on our side. Your disks are safe; nothing was changed."
    >
      <button
        type="button"
        data-testid="error-retry"
        onClick={() => retry()}
        className="rounded-full px-4 py-1.5 text-[13px] font-semibold text-white"
        style={{ background: 'var(--primary-action)' }}
      >
        Try again
      </button>
      <StateLink href={homeHref}>{homeLabel}</StateLink>
      {error.digest && (
        <span data-testid="error-reference" className="basis-full font-mono text-[11.5px]" style={{ color: 'var(--muted-2)' }}>
          Reference: {error.digest}
        </span>
      )}
    </StateCard>
  );
}
