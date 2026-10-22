'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { SortSelect } from '@/components/prefs/sort-select';
import { latestSaver } from '@/lib/user-prefs-client';
import { LIBRARY_SORT_OPTIONS, sortOptionId, type LibrarySort } from '@/lib/user-prefs-schema';
import { pageHref } from '@/lib/library-paging';

/**
 * The library's sort, remembered per user (user prefs library.sort). The
 * library is sorted on the server (listGames caps at 200, so the browser
 * cannot sort it), so a change is saved FIRST and the page refreshed after:
 * refreshing before the save lands would draw the old order again.
 *
 * Never disabled while saving: arrow keys on a closed <select> fire a change
 * per press, and a disabled select would swallow the next one. Only the
 * latest choice is saved and refreshed (latestSaver); the picker then follows
 * the server's value whenever a refresh brings a different one.
 */
export function LibrarySortPicker({ sort }: { sort: LibrarySort }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [saver] = useState(latestSaver);
  const [value, setValue] = useState(sort);
  const [serverSort, setServerSort] = useState(sort);
  const [, startTransition] = useTransition();
  if (sortOptionId(sort) !== sortOptionId(serverSort)) {
    setServerSort(sort);
    setValue(sort);
  }

  async function change(next: LibrarySort) {
    setValue(next);
    try {
      if (await saver.save({ library: { sort: next } }) === 'saved') {
        // A new order starts at its first page (library paging): page 3 of another order is other titles.
        const params = new URLSearchParams(searchParams.toString());
        startTransition(() => (params.has('page') ? router.push(pageHref(params, 1)) : router.refresh()));
      }
    } catch {
      setValue(serverSort);
      toast.error("Couldn't save the sort order. Try again.");
    }
  }

  return <SortSelect options={LIBRARY_SORT_OPTIONS} value={value} onChange={(s) => void change(s)} testId="library-sort" />;
}
