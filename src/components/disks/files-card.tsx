'use client';
import type { ReactNode } from 'react';
import { useFileEdit } from './file-actions';

/** The Files card (C4 spec §4): heading, the tree's controls, the toolbar, the disabled reason, then the body. */
export function FilesCard({ controls = null, toolbar, children }: { controls?: ReactNode; toolbar: ReactNode; children: ReactNode }) {
  const { disabled } = useFileEdit();
  return (
    <section aria-labelledby="files-heading" data-testid="files-card" className="flex flex-col overflow-hidden rounded-[20px]"
             style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
      <div className="flex flex-col border-b" style={{ borderColor: 'var(--line)' }}>
        <div className="flex flex-wrap items-center gap-2.5 px-4 py-3.5">
          <h2 id="files-heading" tabIndex={-1}
              className="mr-auto rounded-[6px] text-[15px] font-semibold focus:outline-2 focus:outline-offset-2 focus:outline-(--ring)"
              style={{ color: 'var(--ink)' }}>Files</h2>
          {controls}
          {toolbar}
        </div>
        {disabled && (
          <p className="-mt-1 px-4 pb-3 text-[13px] font-semibold" style={{ color: 'var(--amber-text)' }}
             data-testid="file-edit-disabled">{disabled.message}</p>
        )}
      </div>
      {children}
    </section>
  );
}
