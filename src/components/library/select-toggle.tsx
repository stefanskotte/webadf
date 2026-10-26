'use client';

import { useLayoutEffect } from 'react';
import { ListChecks } from 'lucide-react';
import { pageHeading } from '@/components/admin/page-heading';
import { useLibrarySelection } from './selection-provider';

/**
 * "Select titles" (spec §1.1, Ruling 1): the header icon, directly before the Grid/Table toggle and the same size
 * (44 x 40 below sm, 36 x 32 from sm). Pressed on, the bar, the checkboxes and the label cards appear; pressed again
 * it is Cancel. `.seg-item[aria-pressed="true"]` draws the pressed look (globals.css).
 *
 * The page only renders it while it shows titles. When a refresh empties the view while it holds focus (the last
 * titles deleted, Review Focus 4), it unmounts under the focus: the h1 takes it, never <body>.
 */
export function SelectToggle() {
  const { selecting, start, cancel, toggleRef } = useLibrarySelection();
  useLayoutEffect(() => {
    const el = toggleRef.current;
    return () => {
      if (!el || document.activeElement !== el) return;
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) pageHeading()?.focus();
      });
    };
  }, [toggleRef]);
  return (
    <div className="seg">
      <button
        ref={toggleRef}
        type="button"
        data-testid="library-select-toggle"
        aria-label="Select titles"
        title="Select titles"
        aria-pressed={selecting}
        onClick={() => (selecting ? cancel() : start())}
        className="seg-item seg-item--icon h-10 w-11 sm:h-8 sm:w-9"
      >
        <ListChecks size={16} aria-hidden />
      </button>
    </div>
  );
}
