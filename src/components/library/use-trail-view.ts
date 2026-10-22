'use client';

import { useSearchParams } from 'next/navigation';
import { parseTrailView, type TrailView } from '@/lib/trail';

/**
 * The library view to carry into a title's links (final review M1): the `?view=` the address names -- the toggle
 * always writes one -- so the breadcrumb back keeps a choice made with it. No `?view=`: nothing is carried, and the
 * person's own preference decides, as it did when they arrived.
 */
export function useTrailView(): TrailView {
  return parseTrailView(useSearchParams().get('view') ?? undefined);
}
