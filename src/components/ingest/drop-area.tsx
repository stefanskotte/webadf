'use client';

/**
 * The Upload page's one drop zone, used by both cards so they read alike: same height, icon and Browse button.
 * A <label> around a hidden input, so a click anywhere -- the Browse pill included -- opens the file picker, and
 * the input itself stays the focusable control (the ring shows on the label via focus-within). Each side keeps
 * its own accept list, words and handler.
 */
export function DropArea({
  testId, inputTestId, title, hint, accept, disabled, resetAfterPick, onFiles,
}: {
  testId: string;
  inputTestId: string;
  title: string;
  hint: string;
  accept?: string;
  disabled?: boolean;
  /** Clear the input after a pick, so choosing the same file again fires again. */
  resetAfterPick?: boolean;
  onFiles: (files: FileList) => void;
}) {
  return (
    <label
      data-testid={testId}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files); }}
      className="flex h-44 shrink-0 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 text-center focus-within:ring-2 focus-within:ring-offset-2"
      style={{ borderColor: 'rgb(245 130 46 / 0.55)', background: 'var(--glass-subtle)', '--tw-ring-color': 'var(--accent-amber)' } as React.CSSProperties}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent-amber)" strokeWidth="1.6" aria-hidden>
        <path d="M12 16V4m0 0L8 8m4-4 4 4" />
        <path d="M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3" />
      </svg>
      <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</span>
      <span className="text-[12px]" style={{ color: 'var(--muted)' }}>{hint}</span>
      <span
        aria-hidden
        className="mt-1 flex h-[32px] items-center rounded-lg px-4 text-[13px] font-medium"
        style={{ background: '#fff', border: '1px solid var(--hairline-strong)', boxShadow: 'var(--shadow-card)', color: 'var(--ink)' }}
      >
        Browse…
      </span>
      <input
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        data-testid={inputTestId}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files;
          if (f) onFiles(f);
          if (resetAfterPick) e.target.value = '';
        }}
      />
    </label>
  );
}
