'use client';
import { Popover } from '@base-ui/react/popover';
import { CircleHelpIcon } from 'lucide-react';
import { Link } from '@/components/shell/link';
import { HELP_TOPICS, type HelpTopicId } from '@/lib/help/topics';

/**
 * A "?" that explains the control beside it (spec 2026-10-05-context-help).
 * Tap, click or keyboard opens it -- never hover-only, because a phone has no
 * hover. Clicks are stopped here so a "?" inside a clickable row, card or
 * toggle never also triggers the thing it explains. The icon takes the
 * surrounding text colour, so it reads on the dark page header and on the
 * light cards alike.
 */
export function HelpTip({ topic, className }: { topic: HelpTopicId; className?: string }) {
  const t = HELP_TOPICS[topic];
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid={`help-tip-${topic}`}
        aria-label={`About ${t.title}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full align-middle opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 ${className ?? ''}`}
      >
        <CircleHelpIcon className="h-4 w-4" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} collisionPadding={16} className="z-50">
          <Popover.Popup
            data-testid={`help-pop-${topic}`}
            className="w-[min(300px,calc(100vw-32px))] rounded-xl p-3 text-[13px] font-normal leading-snug shadow-lg outline-none"
            style={{
              background: 'var(--glass-strong)', color: 'var(--ink)',
              border: '1px solid var(--hairline-strong)', backdropFilter: 'blur(16px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <Popover.Title className="mb-1 text-[13px] font-bold">{t.title}</Popover.Title>
            <Popover.Description>{t.short}</Popover.Description>
            <Link href={`/help#${topic}`} data-testid={`help-more-${topic}`}
                  className="mt-2 inline-block font-semibold underline-offset-2 hover:underline">
              More about {t.title} →
            </Link>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
