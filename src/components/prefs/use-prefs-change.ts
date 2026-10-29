'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { savePrefs } from '@/lib/user-prefs-client';
import { prefsDiff, type UserPrefs } from '@/lib/user-prefs-schema';

/**
 * The autosave behind every Settings card that edits preferences (Preferences, Files). Each change saves at once, and
 * only the field that changed, so one changed in another tab since the page loaded is never put back. A failed save
 * puts the draft back to what is stored and says so.
 */
export function usePrefsChange(prefs: UserPrefs) {
  const router = useRouter();
  const [saved, setSaved] = useState(prefs);
  const [draft, setDraft] = useState(prefs);
  const [state, setState] = useState<'saved' | 'saving' | 'failed'>('saved');
  // Saves in flight. Only the last one to finish settles the line, so two quick changes cannot end on "Saving…".
  const pending = useRef(0);

  async function change(next: UserPrefs): Promise<void> {
    const diff = prefsDiff(saved, next);
    setDraft(next);
    setState('saving');
    pending.current += 1;
    try {
      const stored = await savePrefs(diff);
      setSaved(stored);
      if (pending.current === 1) { setDraft(stored); setState('saved'); }
      router.refresh();
    } catch {
      setDraft(saved);
      setState('failed');
      toast.error("Couldn't save your preferences. Try again.");
    } finally {
      pending.current -= 1;
    }
  }

  return { draft, state, change };
}
