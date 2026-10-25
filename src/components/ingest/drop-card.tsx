'use client';
import { useState } from 'react';
import { DiskIcon } from '@/components/ui/disk-icon';
import type { DiskColor } from '@/lib/disk-icon';

/** The shared look of Browse files and Choose files (C3 spec §2.1, §2.2): an ink pill around a hidden file input. */
export const INK_LABEL = 'inline-flex h-[38px] shrink-0 cursor-pointer items-center rounded-[10px] px-3.5 text-[13px] font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-offset-2 aria-disabled:cursor-default aria-disabled:opacity-50';
export const INK_STYLE = { background: 'var(--ink)', color: 'var(--surface)', '--tw-ring-color': 'var(--ring)' } as React.CSSProperties;

/** The Upload page's drop card (C3 spec §2): the whole dashed card takes a drop; its controls open the picker. */
export function DropCard({ testId, headingId, title, help, hint, disk, disabled, onFiles, children }: {
  testId: string; headingId: string; title: string; help?: React.ReactNode; hint: React.ReactNode;
  disk: { color: DiskColor; set: string; title: string }; disabled?: boolean;
  onFiles?: (files: FileList) => void; children?: React.ReactNode;
}) {
  const [over, setOver] = useState(false);
  const drop = !!onFiles && !disabled;
  return (
    <section aria-labelledby={headingId} data-testid={testId} data-over={String(over)} data-drop={onFiles ? 'on' : 'off'}
      onDragOver={(e) => { if (!onFiles) return; e.preventDefault(); if (!over) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
      onDrop={(e) => { if (!onFiles) return; e.preventDefault(); setOver(false); if (drop) onFiles(e.dataTransfer.files); }}
      className="relative flex min-w-0 items-center gap-4 rounded-[20px] border-[1.5px] border-dashed border-[var(--dash)] bg-[var(--surface)] p-5 hover:border-[var(--ink)] data-[over=true]:border-[var(--ink)] data-[over=true]:bg-[var(--surface-2)] sm:gap-5 sm:p-6">
      <span className="shrink-0 sm:hidden"><DiskIcon color={disk.color} size={56} /></span>
      <span className="hidden shrink-0 sm:block"><DiskIcon color={disk.color} size={84} set={disk.set} title={disk.title} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-1">
          <h2 id={headingId} className="text-[20px] font-bold sm:text-[22px]"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>{title}</h2>
          {help}
        </div>
        <div data-testid={`${testId}-hint`} className="text-[13px]" style={{ color: 'var(--muted)' }}>{hint}</div>
        {children}
      </div>
    </section>
  );
}
