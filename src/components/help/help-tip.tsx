'use client';
import { Popover } from '@base-ui/react/popover';
import { Link } from '@/components/shell/link';
import { HELP_TOPICS, type HelpTopicId } from '@/lib/help/topics';

/**
 * A "?" that explains the control beside it (spec 2026-10-05-context-help; look C5 §4, board InfHelp's right
 * column). Tap, click or keyboard opens it -- never hover-only, because a phone has no hover. Clicks are stopped
 * here so a "?" inside a clickable row, card or toggle never also triggers the thing it explains. The round track
 * button turns ink when hovered or open (both values visible, Ruling 18; on an ink bar the on-ink fill instead); 24 px for WCAG 2.2's target size; below sm a 40 x 40 hit area around it (C7 Ruling 14).
 */
export function HelpTip({ topic, className, onInk = false }: {
  topic: HelpTopicId; className?: string;
  /** On an ink bar (the Files source title bar): hovered or open it turns the on-ink fill with an on-ink outline, so it
   *  never merges into the bar as ink on ink would. */
  onInk?: boolean;
}) {
  const t = HELP_TOPICS[topic];
  const lit = onInk
    ? 'hover:bg-(--on-ink-fill) hover:text-(--surface) hover:ring-1 hover:ring-(--on-ink-muted) data-[popup-open]:bg-(--on-ink-fill) data-[popup-open]:text-(--surface) data-[popup-open]:ring-1 data-[popup-open]:ring-(--on-ink-muted)'
    : 'hover:bg-(--ink) hover:text-(--surface) data-[popup-open]:bg-(--ink) data-[popup-open]:text-(--surface)';
  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid={`help-tip-${topic}`}
        aria-label={`About ${t.title}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        className={`relative inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle font-sans text-[12px] font-bold leading-none bg-(--track) text-(--muted) ${lit} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring) max-sm:before:absolute max-sm:before:-inset-2 max-sm:before:content-[''] ${className ?? ''}`}
      >
        <span aria-hidden="true">?</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} collisionPadding={16} className="z-50">
          <Popover.Popup
            data-testid={`help-pop-${topic}`}
            className="flex w-[min(320px,calc(100vw-32px))] flex-col gap-2.5 rounded-[14px] p-4 outline-none"
            style={{ background: 'var(--ink)', boxShadow: '0 20px 40px -12px rgb(36 33 27 / .5)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <Popover.Title className="text-[14px] font-semibold" style={{ color: 'var(--surface)' }}>{t.title}</Popover.Title>
            <Popover.Description className="text-[13px] leading-[1.5]" style={{ color: 'var(--on-ink-2)' }}>{t.short}</Popover.Description>
            <Link href={`/help#${topic}`} data-testid={`help-more-${topic}`} aria-label={`Read the full topic: ${t.title}`}
                  className="self-start text-[13px] font-semibold underline-offset-2 hover:underline"
                  style={{ color: 'var(--on-ink-accent)' }}>
              Read the full topic
            </Link>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
