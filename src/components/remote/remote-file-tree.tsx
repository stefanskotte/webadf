import { fmtSize } from '@/lib/format';
import type { ShareEntry } from '@/lib/share/types';

const dirsFirst = (a: ShareEntry, b: ShareEntry) =>
  (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

const when = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : '');

/**
 * An owner disk's files, read-only (spec §4.5: no file operations on a remote disk): folders open and close with
 * <details>, so the tree works without script. Folders first, then files, each A to Z.
 */
export function RemoteFileTree({ entries }: { entries: ShareEntry[] }) {
  if (entries.length === 0) {
    return <p className="px-4 py-6 text-[13px]" style={{ color: 'var(--muted)' }} data-testid="remote-files-empty">This disk is empty.</p>;
  }
  return <ul className="flex flex-col" data-testid="remote-file-tree">{[...entries].sort(dirsFirst).map((e) => <Entry key={e.name} e={e} depth={0} />)}</ul>;
}

function Entry({ e, depth }: { e: ShareEntry; depth: number }) {
  const pad = { paddingLeft: 16 + depth * 18 };
  const facts = (
    <>
      <span className="ml-auto shrink-0 font-mono text-[12px] max-sm:hidden" style={{ color: 'var(--muted-2)' }}>{when(e.modifiedAt)}</span>
      <span className="w-[72px] shrink-0 text-right font-mono text-[12px]" style={{ color: 'var(--muted)' }}>
        {e.kind === 'file' ? fmtSize(e.sizeBytes) : ''}
      </span>
    </>
  );
  if (e.kind === 'dir') {
    const kids = [...(e.children ?? [])].sort(dirsFirst);
    return (
      <li data-testid="remote-file-entry" data-kind="dir" data-name={e.name}>
        <details>
          <summary className="flex h-10 cursor-pointer list-none items-center gap-2.5 border-b pr-4 text-[13.5px] hover:bg-[color:var(--surface-2)]"
                   style={{ ...pad, borderColor: 'var(--hairline)', color: 'var(--ink)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ color: 'var(--accent-amber)' }}>
              <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
            <span className="min-w-0 truncate font-medium">{e.name}</span>
            {facts}
          </summary>
          {kids.length > 0
            ? <ul>{kids.map((k) => <Entry key={k.name} e={k} depth={depth + 1} />)}</ul>
            : <p className="border-b py-2 text-[12.5px]" style={{ paddingLeft: 34 + depth * 18, borderColor: 'var(--hairline)', color: 'var(--muted-2)' }}>Empty folder</p>}
        </details>
      </li>
    );
  }
  return (
    <li data-testid="remote-file-entry" data-kind="file" data-name={e.name} title={e.comment ?? undefined}
        className="flex h-10 items-center gap-2.5 border-b pr-4 text-[13.5px]"
        style={{ ...pad, borderColor: 'var(--hairline)', color: 'var(--ink)' }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" style={{ color: 'var(--muted)' }}>
        <path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" />
      </svg>
      <span className="min-w-0 truncate">{e.name}</span>
      {facts}
    </li>
  );
}
