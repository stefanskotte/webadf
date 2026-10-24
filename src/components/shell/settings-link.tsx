'use client';

import { SettingsIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Link } from '@/components/shell/link';

/**
 * The header's gear: the person's own Settings (Preferences). Ink, and on
 * /settings… it is the current page: a surface tile with an ink border
 * (the board's gear), plus aria-current so that reading is not colour only.
 */
export function SettingsLink() {
  const active = usePathname().startsWith('/settings');
  return (
    <Link href="/settings" aria-label="Settings" title="Settings" data-testid="settings-link"
          aria-current={active ? 'page' : undefined}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] border text-(--ink) hover:bg-(--track)"
          style={active ? { background: 'var(--surface)', borderColor: 'var(--ink)' } : { borderColor: 'transparent' }}>
      <SettingsIcon className="size-[18px]" aria-hidden />
    </Link>
  );
}
