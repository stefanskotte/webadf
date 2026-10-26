import { Fragment } from 'react';
import { Link } from '@/components/shell/link';
import {
  adminCounts, adminBoardCounts, adminFirmwareDistribution, adminAttentionCandidates,
} from '@/lib/admin-queries';
import { readCurrentRelease } from '@/lib/firmware-releases';
import { needsAttention, orderDistribution, versionLabel } from '@/lib/admin-board-health';
import { nowMs } from '@/lib/clock';
import { overviewTiles, serverAttention, ATTENTION_DOT, REASON_FG } from '@/lib/admin-overview-look';
import { AdminPageHead, ADMIN_BODY } from '@/components/admin/admin-page-head';

// Counts are read live on every render; nothing here is cached. cacheComponents stays off in this project (see
// next.config.ts), and an operator looking at a database overview wants the number as it is now.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Admin · Overview' };

const CARD = { background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' } as const;
const RING = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)';

export default async function AdminOverviewPage() {
  // One `now` for every rule on the page, read once per request (Ruling 3), so the tiles, the distribution and the
  // attention list agree.
  const now = nowMs();
  const [counts, boards, dist, candidates, current] = await Promise.all([
    adminCounts(), adminBoardCounts(now), adminFirmwareDistribution(now), adminAttentionCandidates(now),
    readCurrentRelease(),
  ]);
  const attention = needsAttention(candidates, current, now);
  const distribution = orderDistribution(dist, current?.sequence ?? null);
  const tiles = overviewTiles(counts, boards);
  const server = serverAttention(counts);
  return (
    <>
      <AdminPageHead
        title="Overview"
        subtitleFont="sans"
        subtitle="Every organization at once. These numbers cross the tenant boundary — only server admins see this area."
      />
      <div className={ADMIN_BODY}>
        {/* Six tiles, each a link (Ruling 13). The value span holds only the digits: admin-guard reads ^\d+$. */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {tiles.map((t) => (
            <Link
              key={t.id}
              href={t.href}
              data-warn={t.warn ? 'true' : 'false'}
              // Shadows as classes, not inline: an inline shadow would beat the hover.
              className={`flex flex-col gap-2.5 rounded-[16px] bg-(--surface) p-[18px] shadow-[0_0_0_1px_var(--line)] hover:shadow-[0_0_0_1px_var(--dash),0_12px_24px_-14px_rgb(36_33_27/0.3)] ${RING}`}
            >
              <span className="text-[13px] font-medium" style={{ color: 'var(--muted-2)' }}>{t.label}</span>
              <span
                data-testid={t.id}
                className="text-[40px] font-bold leading-none tabular-nums"
                style={{ fontFamily: 'var(--font-display)', color: t.warn ? 'var(--amber-text)' : 'var(--ink)' }}
              >
                {t.value}
              </span>
              <span className="text-[12px] [overflow-wrap:anywhere]"
                    style={{ color: t.warn ? 'var(--amber-text)' : 'var(--muted-2)' }}>
                {t.note.map((p, i) => (typeof p === 'string'
                  ? <Fragment key={i}>{p}</Fragment>
                  : <span key={i} data-testid={p.id}>{p.value}</span>))}
              </span>
            </Link>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start">
          {/* Boards by firmware (Ruling 15): A7's facts with the board's dots and bars. */}
          <section aria-labelledby="fw-dist-heading" className="flex flex-col gap-3 rounded-[20px] p-5" style={CARD}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="fw-dist-heading" className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
                Boards by firmware
              </h2>
              <Link href="/admin/firmware"
                    className={`text-[13px] font-semibold text-(--amber-text) hover:underline ${RING}`}>
                Firmware registry
              </Link>
            </div>
            <div data-testid="fw-dist" className="flex flex-col gap-2.5">
              {distribution.length === 0 ? (
                <div className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid="fw-dist-empty">
                  No board has been seen in the last 7 days.
                </div>
              ) : distribution.map((row) => (
                <div
                  key={row.version ?? '\u0000null'}
                  className="grid grid-cols-[minmax(0,1fr)_60px] items-center gap-x-3.5 gap-y-1.5 text-[13px] sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)_60px]"
                  data-testid="fw-dist-row"
                  data-version={row.version ?? ''}
                  data-count={row.count}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className="size-[7px] shrink-0 rounded-full"
                          style={{ background: row.current ? 'var(--online-dot)' : 'var(--dash)' }} />
                    <span className="min-w-0 font-mono [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}
                          title={row.version ?? undefined}>
                      {versionLabel(row.version)}
                    </span>
                    {row.current && (
                      <span data-dist="current" className="shrink-0 text-[12px]" style={{ color: 'var(--success-fg)' }}>
                        {' · current'}
                      </span>
                    )}
                    {!row.recognised && row.version !== null && (
                      <span className="shrink-0 text-[12px]" style={{ color: 'var(--muted-2)' }}>{' · unrecognised'}</span>
                    )}
                  </span>
                  {/* Below sm the bar drops under the label and count (order, col-span): beside a 200 px label it was 30 px wide. */}
                  <span aria-hidden data-fw-bar className="order-last col-span-2 h-2 overflow-hidden rounded-full sm:order-none sm:col-span-1" style={{ background: 'var(--track)' }}>
                    <span className="block h-2"
                          style={{ width: `${Math.max(2, row.share * 100)}%`, background: row.current ? 'var(--bar-ok)' : 'var(--dash)' }} />
                  </span>
                  <span className="text-right font-mono tabular-nums" style={{ color: 'var(--muted)' }}>{row.count}</span>
                </div>
              ))}
            </div>
            <p className="text-[12px]" style={{ color: 'var(--muted-2)' }}>
              Boards that reported in the last 7 days: <span data-testid="count-boardsSeen7d">{boards.seen7d}</span>.
            </p>
          </section>

          {/* Needs attention (Ruling 16): server items first, as links; then A7's board rows, not links. */}
          <section aria-labelledby="attention-heading" className="flex flex-col gap-2.5 rounded-[20px] p-5" style={CARD}>
            <h2 id="attention-heading" className="mb-1 text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
              Needs attention
            </h2>
            <ul data-testid="attention" className="flex flex-col gap-2.5">
              {server.map((s) => (
                <li key={s.id}>
                  <Link href={s.href} data-testid={s.id}
                        className={`flex items-start gap-3 rounded-[12px] px-3.5 py-3 hover:shadow-[0_0_0_1px_var(--dash)] ${RING}`}
                        style={{ background: s.bg }}>
                    <span aria-hidden className="mt-[5px] size-2 shrink-0 rounded-full" style={{ background: s.dot }} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span data-attn="title" className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{s.title}</span>
                      <span data-attn="text" className="text-[13px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>{s.text}</span>
                    </span>
                  </Link>
                </li>
              ))}
              {attention.map((row) => (
                <li key={row.deviceId} data-testid="attention-row" data-device-id={row.deviceId}
                    className="flex items-start gap-3 rounded-[12px] px-3.5 py-3" style={{ background: 'var(--surface-2)' }}>
                  <span aria-hidden className="mt-[5px] size-2 shrink-0 rounded-full"
                        style={{ background: ATTENTION_DOT[row.reasons[0]?.kind ?? 'offline'] }} />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span data-attn="title" className="text-[14px] font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--ink)' }}>
                      {row.name}
                    </span>
                    <span className="text-[13px] [overflow-wrap:anywhere]" style={{ color: 'var(--muted)' }}>{row.ownerEmail ?? '—'}</span>
                    <ul className="flex flex-col gap-0.5">
                      {row.reasons.map((reason) => (
                        <li key={reason.kind} data-kind={reason.kind} className="text-[13px] [overflow-wrap:anywhere]"
                            style={{ color: REASON_FG[reason.kind] }}>
                          {reason.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
              {server.length === 0 && attention.length === 0 && (
                <li className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid="attention-empty">
                  Nothing needs attention.
                </li>
              )}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
