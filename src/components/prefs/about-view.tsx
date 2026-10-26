import { Link } from '@/components/shell/link';
import { HelpTip } from '@/components/help/help-tip';
import { Bone } from '@/components/shell/skeleton';
import { CARD_STYLE, SETTINGS_CARD, SETTINGS_H2 } from '@/lib/settings-look';
import { formatBytes } from '@/lib/about/format-bytes';
import { HOSTED_LABEL, SELF_HOSTED_LABEL } from '@/lib/about/hosting';
import type { BuildInfo } from '@/lib/about/build-info';
import type { LibraryUsage } from '@/lib/about/library-usage';

// Settings > About this server (C7 spec §10.1; content moved from the old /about page, every id and word kept). This
// file is markup only and reads no database, so it renders in a unit test; about-server.tsx does the reads.

export type Settled<T> = { ok: true; value: T } | { ok: false };
export type FirmwareFacts = { latest: { version: string; sequence: number } | null; boards: number; behind: number };

/**
 * The card, its id and its heading render with the rest of Settings; only the groups stream (Plan ruling, C7 Task 2).
 * SideNav jumps to and observes the ids that exist when it mounts, so #about and #about-heading must be there then.
 */
export function AboutCard({ children }: { children: React.ReactNode }) {
  return (
    <section id="about" aria-labelledby="about-heading" data-testid="settings-about" className={SETTINGS_CARD} style={CARD_STYLE}>
      <div className="flex items-center gap-1.5">
        <h2 id="about-heading" tabIndex={-1} className={SETTINGS_H2} style={{ color: 'var(--ink)' }}>About this server</h2>
        <HelpTip topic="about" />
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** The groups' place while their reads run (Ruling 23): the card is already there, so only its body is a bone. */
export function AboutBone() {
  return (
    <div data-about-bone="" aria-hidden="true" className="flex flex-col gap-3">
      {Array.from({ length: 6 }, (_, i) => <Bone key={i} className={i % 2 ? 'h-3 w-1/2' : 'h-3 w-2/3'} />)}
    </div>
  );
}

function Group({ id, title, first = false, children }: { id: string; title: string; first?: boolean; children: React.ReactNode }) {
  return (
    <div data-testid={`about-${id}`} className={first ? undefined : 'border-t pt-4'}
         style={first ? undefined : { borderColor: 'var(--hairline)' }}>
      <h3 className="mb-2 text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>{title}</h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]" style={{ color: 'var(--ink)' }}>{children}</dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd className="min-w-0" style={{ overflowWrap: 'anywhere' }}>{children}</dd>
    </>
  );
}

const UNAVAILABLE = <span style={{ color: 'var(--muted)' }}>unavailable</span>;

/** The six groups (spec 2026-10-15-about-page): build, hosting, platform, firmware, this org's library, WebFloppy. */
export function AboutGroupsView({ build, hosted, node, storage, usage, firmware }: {
  build: BuildInfo; hosted: boolean; node: string; storage: string;
  usage: Settled<LibraryUsage>; firmware: Settled<FirmwareFacts>;
}) {
  return (
    <>
      <Group id="web-app" title="Web app" first>
        <Row label="Commit">
          <span data-testid="about-commit">
            {build.commitUrl ? <a href={build.commitUrl} className="underline">{build.shortCommit}</a> : build.shortCommit}
          </span>
        </Row>
        <Row label="Built">
          {build.builtAt
            ? <time dateTime={build.builtAt}>{new Date(build.builtAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</time>
            : 'unknown'}
        </Row>
      </Group>

      <Group id="hosting" title="Hosting">
        <Row label="This server"><span data-testid="about-hosting-mode">{hosted ? HOSTED_LABEL : SELF_HOSTED_LABEL}</span></Row>
      </Group>

      <Group id="platform" title="Platform">
        {/* Template strings: React writes <!-- --> between two adjacent text nodes. */}
        <Row label="Runtime">{`Node.js ${node}`}</Row>
        <Row label="Framework">{`Next.js ${build.nextVersion}`}</Row>
        <Row label="Database">PostgreSQL</Row>
        <Row label="File storage">{storage}</Row>
      </Group>

      <Group id="firmware" title="Board firmware">
        {firmware.ok ? (
          <>
            <Row label="Newest">
              {firmware.value.latest ? `${firmware.value.latest.version} (sequence ${firmware.value.latest.sequence})` : 'none published'}
            </Row>
            <Row label="Your boards">
              {firmware.value.boards === 0 ? 'No boards paired' : `${firmware.value.behind} of ${firmware.value.boards} behind`}
            </Row>
          </>
        ) : <Row label="Firmware">{UNAVAILABLE}</Row>}
      </Group>

      <Group id="library" title="Your library">
        {usage.ok ? (
          <>
            <Row label="Titles"><span data-testid="about-library-titles">{usage.value.titles}</span></Row>
            <Row label="Disks"><span data-testid="about-library-disks">{usage.value.disks}</span></Row>
            <Row label="History versions"><span data-testid="about-library-versions">{usage.value.versions}</span></Row>
            <Row label="Stored">
              <span data-testid="about-library-bytes" data-bytes={usage.value.bytes}
                    title={`${usage.value.bytes.toLocaleString('en-GB')} bytes`}>
                {formatBytes(usage.value.bytes)}
              </span>
            </Row>
          </>
        ) : <Row label="Library">{UNAVAILABLE}</Row>}
      </Group>

      <Group id="about-webadf" title="WebFloppy">
        <Row label="What">An Amiga floppy library that mounts disks on real Amigas over Wi-Fi.</Row>
        <Row label="Licence">MIT</Row>
        <Row label="More">
          <Link href="/help" className="underline">Help</Link> · <a href="https://github.com/stefanskotte/webadf" className="underline">Repository</a>
        </Row>
      </Group>
    </>
  );
}
