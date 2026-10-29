'use client';

import { useId } from 'react';
import { PrefRow } from '@/components/prefs/pref-row';
import { usePrefsChange } from '@/components/prefs/use-prefs-change';
import { SegRadioGroup } from '@/components/ui/seg-radio-group';
import { Switch } from '@/components/ui/switch';
import { CARD_STYLE, SETTINGS_CARD, SETTINGS_H2, prefsStateLook } from '@/lib/settings-look';
import {
  FILES_COMMENT_MODES, FILES_ON_CLASH, FILES_PANE_DEVICES,
  type FilesCommentMode, type FilesOnClash, type FilesPaneDevice, type UserPrefs,
} from '@/lib/user-prefs-schema';

const PANE_OPTIONS = FILES_PANE_DEVICES.map((d) => ({ value: d, label: `${d}:` }));
const COMMENT_LABELS: Record<FilesCommentMode, string> = { auto: 'In STASH:', always: 'Always', never: 'Never' };
const CLASH_LABELS: Record<FilesOnClash, string> = { ask: 'Ask', 'keep-both': 'Keep both', replace: 'Replace', skip: 'Skip' };

/**
 * Settings › Account › Files (Files spec §6, increment 4): how the Files page opens and behaves. The same autosave as
 * the Preferences card (usePrefsChange); each change sends only its own field, so the two cards never put back each
 * other's. Show .info files is the stored `browse.hideInfo`, shown the right way round.
 */
export function FilesSettings({ prefs }: { prefs: UserPrefs }) {
  const { draft, state, change } = usePrefsChange(prefs);
  const leftLabel = useId(); const leftHint = useId();
  const rightLabel = useId(); const rightHint = useId();
  const infoLabel = useId(); const infoHint = useId();
  const commentLabel = useId(); const commentHint = useId();
  const confirmLabel = useId(); const confirmHint = useId();
  const clashLabel = useId(); const clashHint = useId();
  const setFiles = (files: Partial<UserPrefs['files']>) => void change({ ...draft, files: { ...draft.files, ...files } });

  const look = prefsStateLook(state);
  return (
    <section id="files" aria-labelledby="files-heading" data-testid="files-settings" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="files-heading" tabIndex={-1} className={SETTINGS_H2} style={{ color: 'var(--ink)' }}>Files</h2>
        <span data-testid="files-prefs-state" role="status" aria-live="polite" className="flex items-center gap-1.5 text-[12px]"
              style={{ color: look.fg }}>
          <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: look.dot }} />
          {look.text}
        </span>
      </div>
      <p className="mb-2 mt-1 text-[13px]" style={{ color: 'var(--muted-2)' }}>
        How the Files page opens and behaves. Yours alone, like your other preferences.
      </p>
      <PrefRow labelId={leftLabel} hintId={leftHint} label="Left pane opens on"
               hint="When you open Files from the menu. Files… on a disk always opens that disk.">
        <SegRadioGroup testId="pref-files-left" aria-labelledby={leftLabel} aria-describedby={leftHint}
                       value={draft.files.panes.left} options={PANE_OPTIONS}
                       onChange={(left: FilesPaneDevice) => setFiles({ panes: { ...draft.files.panes, left } })} />
      </PrefRow>
      <PrefRow labelId={rightLabel} hintId={rightHint} label="Right pane opens on" hint="The other pane.">
        <SegRadioGroup testId="pref-files-right" aria-labelledby={rightLabel} aria-describedby={rightHint}
                       value={draft.files.panes.right} options={PANE_OPTIONS}
                       onChange={(right: FilesPaneDevice) => setFiles({ panes: { ...draft.files.panes, right } })} />
      </PrefRow>
      <PrefRow labelId={infoLabel} hintId={infoHint} label="Show .info files"
               hint="Workbench icon files. The switch in each pane changes this too.">
        <Switch testId="pref-files-show-info" aria-labelledby={infoLabel} aria-describedby={infoHint}
                checked={!draft.browse.hideInfo}
                onChange={(checked) => void change({ ...draft, browse: { ...draft.browse, hideInfo: !checked } })} />
      </PrefRow>
      <PrefRow labelId={commentLabel} hintId={commentHint} label="Comment column" hint="Wide screens only.">
        <SegRadioGroup testId="pref-files-comments" aria-labelledby={commentLabel} aria-describedby={commentHint}
                       value={draft.files.comments}
                       options={FILES_COMMENT_MODES.map((m) => ({ value: m, label: COMMENT_LABELS[m] }))}
                       onChange={(comments: FilesCommentMode) => setFiles({ comments })} />
      </PrefRow>
      <PrefRow labelId={confirmLabel} hintId={confirmHint} label="Ask before deleting"
               hint="Turned off, a delete on a disk happens at once and can be undone. STASH: and NET: always ask.">
        <Switch testId="pref-files-confirm-delete" aria-labelledby={confirmLabel} aria-describedby={confirmHint}
                checked={draft.files.confirmDelete} onChange={(confirmDelete) => setFiles({ confirmDelete })} />
      </PrefRow>
      <PrefRow labelId={clashLabel} hintId={clashHint} label="When a name already exists"
               hint="Replace overwrites without asking; a disk keeps the old version in History, STASH: does not.">
        <SegRadioGroup testId="pref-files-on-clash" aria-labelledby={clashLabel} aria-describedby={clashHint}
                       value={draft.files.onClash}
                       options={FILES_ON_CLASH.map((c) => ({ value: c, label: CLASH_LABELS[c] }))}
                       onChange={(onClash: FilesOnClash) => setFiles({ onClash })} />
      </PrefRow>
    </section>
  );
}
