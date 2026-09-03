import { MAX_ENTRIES, type AdfEntry, type VolumeResult, type VolumeUsage } from '@/lib/adffs';

/**
 * KB the way an Amiga counts it: 1024 bytes, and whole numbers. A disk this
 * size has no use for a decimal place, and "880 KB" is the number printed on
 * the label of the physical thing.
 */
const formatKb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

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
    <dt className="whitespace-nowrap font-semibold" style={{ color: 'var(--muted)' }}>{label}</dt>
    {/*
      A grid item's automatic minimum size is its content, so a long volume
      name -- and Amiga volume names have no spaces to break at -- would push
      the 1fr track past the card and out of the phone's viewport rather than
      wrapping. min-w-0 lets the track shrink; break-words then breaks the
      name itself. Neither has any effect at a width where the value fits.
    */}
    <dd className="min-w-0 break-words">{children}</dd>
  </div>
);

export function VolumeHeader({ result, filename, usage }: {
  result: VolumeResult; filename: string; usage?: VolumeUsage | null;
}) {
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
        {/* Read from the allocation bitmap, which is the only thing on a disk
            that knows. Absent rather than guessed when the bitmap cannot be
            trusted: this is the figure a person acts on when deciding whether
            something fits, so a confident wrong number is worse than none. */}
        <Fact label="Space">
          {usage ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="volume-usage">
              <span data-testid="volume-usage-text">
                {formatKb(usage.usedBytes)} used of {formatKb(usage.totalBytes)}
                {' '}· {formatKb(usage.freeBytes)} free
              </span>
              <span
                aria-hidden
                className="h-1.5 w-28 overflow-hidden rounded-full"
                style={{ background: 'var(--hairline-strong)' }}
              >
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${usage.percentUsed}%`,
                    // Fill, never text -- --accent-amber fails AA as a colour
                    // to read, and this bar is read as a shape.
                    background: usage.percentUsed >= 90 ? 'var(--accent-amber)' : 'var(--primary-action)',
                  }}
                />
              </span>
              <span style={{ color: 'var(--muted-2)' }}>{usage.percentUsed}%</span>
            </span>
          ) : (
            <span style={{ color: 'var(--muted-2)' }} data-testid="volume-usage-unknown">
              unknown — this disk&apos;s allocation bitmap is not usable
            </span>
          )}
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
          listing truncated at {MAX_ENTRIES.toLocaleString()} entries
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
