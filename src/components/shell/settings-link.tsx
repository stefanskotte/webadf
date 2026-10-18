import { SettingsIcon } from 'lucide-react';
import { Link } from '@/components/shell/link';

/** The header's gear: the person's own Settings (Preferences). Same colours as About and Sign out. */
export function SettingsLink() {
  return (
    <Link href="/settings" aria-label="Settings" title="Settings" data-testid="settings-link"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[color:var(--on-dark-muted)] hover:bg-white/10 hover:text-[color:var(--on-dark)]">
      <SettingsIcon className="size-[18px]" aria-hidden />
    </Link>
  );
}
