import { InfoIcon } from 'lucide-react';
import { Link } from '@/components/shell/link';

/** The header's (i): what this server is (About page spec D4). Same colours as Sign out. */
export function AboutLink() {
  return (
    <Link href="/about" aria-label="About this server" title="About this server"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-[color:var(--on-dark-muted)] hover:bg-white/10 hover:text-[color:var(--on-dark)]">
      <InfoIcon className="size-[18px]" aria-hidden />
    </Link>
  );
}
