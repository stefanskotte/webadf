import { protectionChips } from '@/lib/disk-files-look';

/**
 * The eight AmigaDOS protection bits as letter cells (Ruling 13): a set bit shows its letter on the track tone, a
 * clear one a muted dash. Shared by the Browse table (file-tree.tsx) and the Files panes; the caller supplies the row.
 */
export function ProtectionCells({ protection }: { protection: string }) {
  return protectionChips(protection).map((c) => (
    <span key={c.letter} title={c.label} className="grid h-[18px] w-[14px] place-items-center rounded-[4px]"
          style={c.on ? { background: 'var(--track)', color: 'var(--ink)' } : { color: 'var(--muted-2)' }}>
      {c.on ? c.letter : '-'}
    </span>
  ));
}
