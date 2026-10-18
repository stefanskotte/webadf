'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { SortSelect } from '@/components/prefs/sort-select';
import { savePrefs } from '@/lib/user-prefs-client';
import { LIBRARY_SORT_OPTIONS, type LibrarySort } from '@/lib/user-prefs-schema';

/**
 * The library's sort, remembered per user (user prefs library.sort). The
 * library is sorted on the server (listGames caps at 200, so the browser
 * cannot sort it), so a change is saved FIRST and the page refreshed after:
 * refreshing before the save lands would draw the old order again.
 */
export function LibrarySortPicker({ sort }: { sort: LibrarySort }) {
  const router = useRouter();
  const [value, setValue] = useState(sort);
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  async function change(next: LibrarySort) {
    const before = value;
    setValue(next);
    setSaving(true);
    try {
      await savePrefs({ library: { sort: next } });
      startTransition(() => router.refresh());
    } catch {
      setValue(before);
      toast.error("Couldn't save the sort order. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SortSelect options={LIBRARY_SORT_OPTIONS} value={value} onChange={(s) => void change(s)}
                disabled={saving || pending} testId="library-sort" />
  );
}
