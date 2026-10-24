import { InfoIcon } from 'lucide-react';
import { Link } from '@/components/shell/link';

/** The header's (i): what this server is (About page spec D4). Muted at rest, ink on hover, like Sign out. */
export function AboutLink() {
  return (
    <Link href="/about" aria-label="About this server" title="About this server" data-testid="about-link"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] text-(--muted) hover:bg-(--track) hover:text-(--ink)">
      <InfoIcon className="size-[18px]" aria-hidden />
    </Link>
  );
}
