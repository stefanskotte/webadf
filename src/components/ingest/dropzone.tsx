'use client';
import { SetSuggestion } from './set-suggestion';
import { UrlFetch } from './url-fetch';
import { DropCard, INK_LABEL, INK_STYLE, TILE, TILE_LOOK } from './drop-card';
import { useStaging } from './staging-provider';
import { useLibraryIngest } from '@/components/library-ingest/use-library-ingest';

/** The Upload page's Add-to-library card: the library ingest pipeline (src/lib/library-ingest/run.ts, through
 *  useLibraryIngest) with its rows fed into the Staging list. */
export function Dropzone() {
  const { setLibRows, refreshNow } = useStaging();
  const { busy, setBusy, suggestion, clearSuggestion, addFiles, addFetched } =
    useLibraryIngest({ setRows: setLibRows, onSettled: refreshNow });
  const handleFiles = (fileList: FileList) => addFiles([...fileList]);

  return (
    // The Add-to-library card (src/app/(app)/ingest/page.tsx): drop zone, URL fetch and the set suggestion.
    // What each file did shows in the Staging list below both cards.
    <DropCard testId="dropzone" headingId="add-heading" title="Add disks to the library"
      hint="ADF, ADZ, DMS, DMZ or HFE. Hashed in your browser first — only missing disks upload."
      disk={{ color: 'black', set: 'ADF · ADZ · DMS · HFE', title: 'Add to library' }} tileCol={1}
      disabled={busy} onFiles={(f) => void handleFiles(f)}>
      <div className="flex flex-col gap-2 max-sm:contents sm:flex-row sm:flex-wrap sm:items-center">
        {/* Below sm this label is the Add tile (C7 spec §7); its word is data-tile, so its text stays "Browse files". */}
        <label htmlFor="add-file-input" data-testid="add-browse" data-tile={busy ? 'Working…' : 'Add to library'}
               className={`${INK_LABEL} ${TILE_LOOK} ${TILE[1]}`} style={INK_STYLE}>
          <span className="max-sm:hidden">{busy ? 'Working…' : 'Browse files'}</span>
          <input id="add-file-input" type="file" multiple aria-label="Browse files" accept=".adf,.dsk,.adz,.dms,.dmz,.hfe" className="sr-only"
                 data-testid="file-input" disabled={busy}
                 onChange={(e) => { const f = e.target.files; if (f) void handleFiles(f); }} />
        </label>
        <UrlFetch busy={busy} setBusy={setBusy} onRows={addFetched} />
      </div>
      {suggestion && (
        <div className="max-sm:order-2 max-sm:col-span-2">
          <SetSuggestion suggestion={suggestion} onDone={clearSuggestion} />
        </div>
      )}
    </DropCard>
  );
}
