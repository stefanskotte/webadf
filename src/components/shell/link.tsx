'use client';

import NextLink from 'next/link';
import type { ComponentProps } from 'react';
import { PendingReporter } from './nav-progress';

/**
 * next/link, plus this app's navigation feedback.
 *
 * Import this instead of next/link anywhere a click navigates. The only
 * difference is the reporter child, which renders null and exists so that
 * useLinkStatus() -- readable only BELOW a <Link> -- can tell the shell a
 * navigation is in flight. Everything else, props included, is next/link's.
 *
 * A plain next/link still works; it just navigates without the bar.
 */
export function Link({ children, ...props }: ComponentProps<typeof NextLink>) {
  return (
    <NextLink {...props}>
      {children}
      <PendingReporter />
    </NextLink>
  );
}
