import { requireOrg } from '@/lib/session';
import { PageHeader } from '@/components/shell/page-header';
import { Link } from '@/components/shell/link';
import { buildInfo } from '@/lib/about/build-info';
import { hostingMode, HOSTED_LABEL, SELF_HOSTED_LABEL } from '@/lib/about/hosting';
import { libraryUsage } from '@/lib/about/library-usage';
import { firmwareSummary } from '@/lib/about/firmware-summary';
import { settle } from '@/lib/about/settle';
import { formatBytes } from '@/lib/about/format-bytes';
import { STORAGE_BACKEND } from '@/lib/storage';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="glass-card p-5" data-testid={`about-${id}`}>
      <h2 className="mb-2 text-[13px] font-semibold">{title}</h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">{children}</dl>
    </section>
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

/** What this server is (spec 2026-10-15-about-page): build, hosting, platform, firmware, this org's library. */
export default async function AboutPage() {
  const { orgId } = await requireOrg();
  // Each section settles on its own, so one failing read blanks only its section.
  const [usage, firmware] = await Promise.all([settle(libraryUsage(orgId)), settle(firmwareSummary(orgId))]);
  const build = buildInfo();
  const hosted = hostingMode() === 'hosted';

  return (
    <>
      <PageHeader eyebrow="Server" title="About" help="about" />
      <div className="flex flex-col gap-3 px-4 pb-10 sm:px-7">
        <Section id="web-app" title="Web app">
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
        </Section>

        <Section id="hosting" title="Hosting">
          <Row label="This server"><span data-testid="about-hosting-mode">{hosted ? HOSTED_LABEL : SELF_HOSTED_LABEL}</span></Row>
        </Section>

        <Section id="platform" title="Platform">
          <Row label="Runtime">Node.js {process.versions.node}</Row>
          <Row label="Framework">Next.js {build.nextVersion}</Row>
          <Row label="Database">PostgreSQL</Row>
          <Row label="File storage">{STORAGE_BACKEND}</Row>
        </Section>

        <Section id="firmware" title="Board firmware">
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
        </Section>

        <Section id="library" title="Your library">
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
        </Section>

        <Section id="about-webadf" title="webadf">
          <Row label="What">An Amiga floppy library that mounts disks on real Amigas over Wi-Fi.</Row>
          <Row label="Licence">MIT</Row>
          <Row label="More">
            <Link href="/help" className="underline">Help</Link> · <a href="https://github.com/stefanskotte/webadf" className="underline">Repository</a>
          </Row>
        </Section>
      </div>
    </>
  );
}
