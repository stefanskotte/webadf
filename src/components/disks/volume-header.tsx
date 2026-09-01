import type { AdfEntry, VolumeResult } from '@/lib/adffs';

/**
 * Copy for the three ways a disk can answer "no filesystem". Verbatim from
 * the task brief -- these are read by real users deciding whether a disk is
 * broken, not just by tests.
 *
 * `no-dos-signature` and `no-filesystem` are both ordinary properties of a
 * game disk (design decision D-3-3 in the adffs reader): only `not-adf` is
 * actually a catalog problem.
 */
const NO_FILESYSTEM_COPY: Record<'not-adf' | 'no-dos-signature' | 'no-filesystem', string> = {
  'not-adf': 'This image is not a standard 880 KB ADF.',
  'no-dos-signature':
    'No AmigaDOS filesystem — this disk has no DOS signature, which is normal for a game or demo with a custom bootblock.',
  'no-filesystem':
    'No AmigaDOS filesystem — the disk has a DOS signature but no valid root block, which is normal for a cracked or copy-protected game.',
};

/** Recursively counts files and directories across the whole tree, not just the root listing. */
function countEntries(entries: AdfEntry[]): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      dirs++;
      const nested = countEntries(entry.children);
      files += nested.files;
      dirs += nested.dirs;
    } else {
      files++;
    }
  }
  return { files, dirs };
}

const Badge = ({ label }: { label: string }) => (
  <span
    className="rounded px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide"
    style={{ background: 'var(--glass-strong)', color: 'var(--ink)' }}
  >
    {label}
  </span>
);

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="contents">
    <dt className="font-semibold" style={{ color: 'var(--muted)' }}>{label}</dt>
    <dd>{children}</dd>
  </div>
);

export function VolumeHeader({ result, filename }: { result: VolumeResult; filename: string }) {
  if (!result.ok) {
    return (
      <div
        className="glass-card p-5 text-[13px]"
        style={{ color: 'var(--muted)' }}
        data-testid="no-filesystem"
      >
        {NO_FILESYSTEM_COPY[result.reason]}
      </div>
    );
  }

  const { volume, root, truncated, warnings } = result;
  const { files, dirs } = countEntries(root);

  return (
    <div className="glass-card p-5" data-testid="volume-header">
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-[13px]">
        <Fact label="Filesystem">
          <span className="inline-flex items-center gap-2">
            {volume.filesystem}
            {volume.intl && <Badge label="INTL" />}
            {volume.dirc && <Badge label="DIRC" />}
          </span>
        </Fact>
        {volume.name && volume.name !== filename && <Fact label="Volume name">{volume.name}</Fact>}
        <Fact label="Contents">
          {files} file{files === 1 ? '' : 's'}, {dirs} director{dirs === 1 ? 'y' : 'ies'}
        </Fact>
        {volume.createdAt && (
          <Fact label="Created">{volume.createdAt.toISOString().slice(0, 10)}</Fact>
        )}
        {volume.modifiedAt && (
          <Fact label="Modified">{volume.modifiedAt.toISOString().slice(0, 10)}</Fact>
        )}
      </dl>

      {truncated && (
        <p className="mt-3 text-[12px]" style={{ color: 'var(--amber-text)' }} data-testid="listing-truncated">
          listing truncated at 10,000 entries
        </p>
      )}
      {warnings.length > 0 && (
        <p className="mt-3 text-[12px]" style={{ color: 'var(--amber-text)' }} data-testid="volume-warnings">
          {warnings.join('; ')}
        </p>
      )}
    </div>
  );
}
