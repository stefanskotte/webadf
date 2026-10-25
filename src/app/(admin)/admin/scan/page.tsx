import { scanStatus } from '@/lib/tosec-sweep';
import { nowMs } from '@/lib/clock';
import { readTosecFetchState } from '@/lib/tosec-fetch';
import { readDemozooImportState } from '@/lib/demozoo/import';
import { demozooStatusText } from '@/lib/demozoo/status';
import { scanCoverage, enrichCoverage, scanNotes, plural, type Coverage, type ScanNoteKind } from '@/lib/admin-scan-look';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';
import { DatUpload } from '@/components/admin/dat-upload';
import { RunScanButton } from '@/components/admin/run-scan-button';
import { OpenRetroUpload } from '@/components/admin/openretro-upload';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Scan' };

const CARD = 'flex flex-col gap-3.5 rounded-[20px] p-5';
const CARD_STYLE = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' } as const;
type Tone = 'ok' | 'miss' | 'plain';
const SQUARE: Record<Tone, string> = { ok: 'var(--bar-ok)', miss: 'var(--fetch-dot)', plain: 'var(--dash)' };
const NOTE_DOT: Record<ScanNoteKind, string> = {
  unchecked: 'var(--fetch-dot)', unreadable: 'var(--danger-fg)', 'no-openretro': 'var(--dash)', enrich: 'var(--dash)',
  done: 'var(--online-dot)',
};

function CardHead({ id, title, source }: { id: string; title: string; source: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h2 id={id} className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h2>
      <span data-source className="font-mono text-[12px]" style={{ color: 'var(--muted-2)' }}>{source}</span>
    </div>
  );
}

function Figure({ c }: { c: Coverage }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-[40px] font-bold leading-none" style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
        {c.recognisedPct === null ? '—' : `${c.recognisedPct}%`}
      </span>
      <span className="text-[18px]" style={{ color: 'var(--muted-2)' }}>
        {c.recognisedPct === null ? ' nothing decided yet' : ' recognised'}
      </span>
    </div>
  );
}

/** Decoration beside the figure and the counts (they carry the values). */
function Bar({ c }: { c: Coverage }) {
  return (
    <div aria-hidden className="flex h-2.5 gap-0.5 overflow-hidden rounded-full" style={{ background: 'var(--track)' }}>
      <span style={{ width: `${c.okW}%`, background: 'var(--bar-ok)' }} />
      <span style={{ width: `${c.missW}%`, background: 'var(--fetch-dot)' }} />
    </div>
  );
}

function Count({ label, id, value, tone = 'plain' }: { label: string; id: string; value: number; tone?: Tone }) {
  return (
    <div className="flex justify-between gap-2 text-[13px]">
      <span data-count-label className="flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
        <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: SQUARE[tone] }} />
        {label}
      </span>
      <span data-testid={id} className="font-mono tabular-nums" style={{ color: 'var(--ink)' }}>{value}</span>
    </div>
  );
}

export default async function AdminScanPage() {
  const s = await scanStatus();
  // The table may not exist yet (deploy before migration): the page must not 500 over a status line.
  const fetchState = await readTosecFetchState().catch(() => null);
  // null = never fetched; 'unreadable' = the read failed. Distinct on purpose.
  const demozooState = await readDemozooImportState().catch(() => 'unreadable' as const);
  const now = nowMs();   // read once per request (Ruling 3)
  const identity = scanCoverage(s);
  const details = enrichCoverage(s);
  const notes = scanNotes(s);

  return (
    <>
      <AdminPageHead
        title="Scan"
        subtitleFont="sans"
        subtitle="Recognises disks against TOSEC, then fills in years, publishers and covers from OpenRetro and Demozoo."
        actions={<RunScanButton />}
      />
      <div className={ADMIN_BODY}>
        {/* Three source cards (Rulings 22, 23); every count keeps its id and holds only the digits. */}
        <div className="grid gap-5 lg:grid-cols-3">
          <section aria-labelledby="identity-heading" data-testid="scan-identity" className={CARD} style={CARD_STYLE}>
            <CardHead id="identity-heading" title="Identity" source={`TOSEC · ${s.tosecEntries} entries`} />
            <Figure c={identity} />
            <Bar c={identity} />
            {/* Named rather than silently deducted: a rate that quietly excludes things is a rate nobody can check. */}
            {identity.authoredDecided > 0 && (
              <span data-testid="scan-excluded" className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
                {identity.authoredDecided} self-made {plural(identity.authoredDecided, 'disk', 'disks')} excluded
              </span>
            )}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Count label="Blobs" id="scan-blobs" value={s.blobs} />
              <Count label="Hashed" id="scan-hashed" value={s.hashed} />
              <Count label="Matched" id="scan-matched" value={s.matched} tone="ok" />
              <Count label="No match" id="scan-none" value={s.none} tone="miss" />
              <Count label="Ambiguous" id="scan-ambiguous" value={s.ambiguous} />
              <Count label="Unreadable" id="scan-unreadable" value={s.unreadable} />
              <Count label="Unchecked" id="scan-unchecked" value={s.unchecked} />
            </div>
          </section>

          <section aria-labelledby="details-heading" data-testid="scan-details" className={CARD} style={CARD_STYLE}>
            <CardHead id="details-heading" title="Details"
                      source={<>OpenRetro · <span data-testid="scan-openretroEntries">{s.openretroEntries}</span> entries</>} />
            <Figure c={details} />
            <Bar c={details} />
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Count label="Enriched" id="scan-enriched" value={s.enriched} tone="ok" />
              <Count label="Not in OpenRetro" id="scan-enrichNone" value={s.enrichNone} tone="miss" />
              <Count label="Ambiguous" id="scan-enrichAmbiguous" value={s.enrichAmbiguous} />
              <Count label="Unchecked" id="scan-enrichUnchecked" value={s.enrichUnchecked} />
              {/* The storage cost of copying someone else's images into our own store stays a number on the page. */}
              <div className="flex flex-col gap-0.5">
                <Count label="Images stored" id="scan-imagesStored" value={s.imagesStored} />
                <span data-testid="scan-imageMb" className="self-end text-[12px]" style={{ color: 'var(--muted-2)' }}>
                  {(s.imageBytes / (1024 * 1024)).toFixed(1)} MB
                </span>
              </div>
            </div>
          </section>

          <section aria-labelledby="demos-heading" data-testid="scan-demos" className={CARD} style={CARD_STYLE}>
            <CardHead id="demos-heading" title="Demos" source="Demozoo · weekly" />
            {/* No figure (Ruling 23): there is no per-blob Demozoo verdict to count. */}
            <p data-testid="demozoo-status" className="text-[14px] leading-[1.5]" style={{ color: 'var(--muted)' }}>
              {demozooStatusText(demozooState, now)}
            </p>
          </section>
        </div>

        <ul data-testid="scan-notes" role="status" className="flex flex-col gap-2 text-[14px]" style={{ color: 'var(--muted)' }}>
          {notes.map((n) => (
            <li key={n.kind} data-testid="scan-note" data-kind={n.kind} className="flex items-center gap-2.5">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: NOTE_DOT[n.kind] }} />
              <span style={n.kind === 'unreadable' ? { color: 'var(--amber-text)' } : undefined}>{n.text}</span>
            </li>
          ))}
        </ul>

        <div className="grid gap-5 md:grid-cols-2 md:items-start">
          <section aria-labelledby="dat-heading" className="flex flex-col items-start gap-2.5 rounded-[20px] p-5" style={CARD_STYLE}>
            <h2 id="dat-heading" className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>Import a TOSEC DAT</h2>
            <p className="text-[14px] leading-[1.5]" style={{ color: 'var(--muted)' }}>
              One or more .dat files, ClrMamePro or XML. Importing a set again updates it in place.
            </p>
            <DatUpload labelledBy="dat-heading" />
            <div className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid="tosec-fetch-status">
              {fetchState?.release ? (
                <div>
                  TOSEC: release {fetchState.release}
                  {fetchState.importedAt ? ` imported ${fetchState.importedAt.toISOString().slice(0, 10)}` : ''}
                </div>
              ) : (
                <div>TOSEC: not fetched yet — the monthly fetch runs on the 2nd</div>
              )}
              {(fetchState?.lastResult?.startsWith('TOSEC fetch failed:') || fetchState?.lastResult?.startsWith('failed:')) && (
                <div>
                  Last automatic fetch ({fetchState.lastAttemptAt?.toISOString().slice(0, 10)}): {fetchState.lastResult}
                </div>
              )}
            </div>
          </section>
          <section aria-labelledby="openretro-heading" className="flex flex-col items-start gap-2.5 rounded-[20px] p-5" style={CARD_STYLE}>
            <h2 id="openretro-heading" className="text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>Import OpenRetro metadata</h2>
            <p className="text-[14px] leading-[1.5]" style={{ color: 'var(--muted)' }}>
              The Amiga.sqlite that FS-UAE Launcher syncs. A newer sync updates entries in place.
            </p>
            <OpenRetroUpload labelledBy="openretro-heading" />
            <p className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid="openretro-hint">
              Run FS-UAE Launcher once to produce <strong>Amiga.sqlite</strong>; find it in FS-UAE&apos;s data folder and upload it here.
            </p>
          </section>
        </div>

        {/* The only place the loaded sets are listed (Ruling 26); admin-scan reads its rows by role. */}
        <section aria-labelledby="sets-heading" className="overflow-hidden rounded-[16px]" style={CARD_STYLE}>
          <h2 id="sets-heading" className="px-5 pb-3 pt-4 text-[16px] font-semibold" style={{ color: 'var(--ink)' }}>TOSEC sets</h2>
          <div className="overflow-x-auto">
            {/* Two of the three columns are long single tokens ("Commodore Amiga - Games - [ADF]",
                "TOSEC-v2023-01-08"): 640px keeps both on one line and lets the card scroll on a phone. */}
            <table className="w-full min-w-[640px] text-[14px]" style={{ color: 'var(--ink)' }}>
              <thead>
                <tr className="h-11 border-b text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--muted-2)' }}>
                  <th scope="col" className="px-5 text-left font-medium">Set</th>
                  <th scope="col" className="px-3.5 text-left font-medium">Version</th>
                  <th scope="col" className="px-5 text-right font-medium">Entries</th>
                </tr>
              </thead>
              <tbody>
                {s.sets.length === 0 ? (
                  <tr>
                    <td className="px-5 py-3" colSpan={3} style={{ color: 'var(--muted)' }}>
                      No DAT sets loaded. Nothing can be matched until one is uploaded.
                    </td>
                  </tr>
                ) : (
                  s.sets.map((set) => (
                    <tr key={`${set.setName}:${set.setVersion}`} className="border-b" style={{ borderColor: 'var(--hairline)' }}>
                      <td className="px-5 py-3 [overflow-wrap:anywhere]">{set.setName}</td>
                      <td className="px-3.5 py-3 font-mono text-[13px]" style={{ color: 'var(--muted)' }}>{set.setVersion ?? '—'}</td>
                      <td className="px-5 py-3 text-right font-mono tabular-nums" data-testid="set-entries">{set.entries}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
