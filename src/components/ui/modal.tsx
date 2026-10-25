'use client';
import type { ReactNode, RefObject } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { XIcon } from 'lucide-react';

/**
 * The shared modal (Devices spec §10.1): Base UI's Dialog, portalled, with a header (title, subtitle, a badge, a
 * close button), a scrolling body and a footer on `--modal-foot`. Full screen below `sm`.
 *
 * `dismissible` is false while a request runs: Escape, the backdrop and the close button are then all inert
 * (`disablePointerDismissal`, an `onOpenChange` gate, and `disabled` on the close button, so it also looks and
 * announces as unavailable). Focus moves into the popup on open and returns on close to `finalFocus`, else
 * to the element focused before opening (Base UI's default).
 */
export function Modal({
  open, onOpenChange, title, subtitle, badge, footer, width, testId, dismissible, closeTestId, finalFocus, attrs, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: ReactNode;
  /** Extra header content, e.g. an "Unsaved changes" pill. */
  badge?: ReactNode;
  footer: ReactNode;
  width: 620 | 940;
  testId: string;
  dismissible: boolean;
  closeTestId: string;
  finalFocus?: RefObject<HTMLElement | null>;
  /** Extra data attributes on the popup, e.g. `data-device-id`. */
  attrs?: Record<`data-${string}`, string>;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => { if (next || dismissible) onOpenChange(next); }}
      disablePointerDismissal={!dismissible}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50" style={{ background: 'var(--scrim)' }} />
        <Dialog.Popup
          {...attrs}
          data-testid={testId}
          finalFocus={finalFocus}
          className="glass-card wf-modal fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden max-sm:inset-0 max-sm:max-h-none max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none"
          style={{ maxWidth: width }}
        >
          <div className="flex items-start gap-4 border-b px-6 pb-4 pt-5" style={{ borderColor: 'var(--line)' }}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-3">
                <Dialog.Title className="text-[24px] font-bold leading-tight"
                              style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
                  {title}
                </Dialog.Title>
                {badge}
              </div>
              {subtitle != null && (
                <Dialog.Description className="text-[13px]" style={{ color: 'var(--muted)' }}>
                  {subtitle}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close data-testid={closeTestId} aria-label="Close" disabled={!dismissible}
                          className="flex size-9 shrink-0 items-center justify-center rounded-[10px] hover:bg-[var(--track)] disabled:opacity-45"
                          style={{ color: 'var(--muted)' }}>
              <XIcon className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          <div className="flex items-center gap-2.5 border-t px-6 py-3.5"
               style={{ borderColor: 'var(--line)', background: 'var(--modal-foot)' }}>
            {footer}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
