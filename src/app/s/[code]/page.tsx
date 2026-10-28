import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Logo } from '@/components/shell/logo';
import { LandingLink } from '@/components/share/landing-link';
import { SHARE_CODE_RE } from '@/lib/share/link';

export const metadata: Metadata = { title: 'Shared library', robots: { index: false, follow: false } };

/**
 * Where a share link lands when someone opens it in a browser (spec §3.4). No sign-in, and NO database: the page
 * never claims the code and never looks it up, so it says nothing about the owner or whether the code is live
 * (Ruling P4: generic text, not the library's name). next.config sends no-referrer and no-store for /s/*: the code is
 * in the path.
 */
export default async function ShareLanding({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const valid = SHARE_CODE_RE.test(code);
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '';
  const proto = h.get('x-forwarded-proto') ?? 'https';
  const fallback = `${proto}://${host}/s/${code}`;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[520px] flex-col justify-center gap-6 px-4 py-10"
          style={{ background: 'var(--ground)' }}>
      <div className="flex items-center gap-2.5">
        <Logo size={26} />
        <span className="text-[20px] font-bold tracking-[-0.02em]" style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>webfloppy</span>
      </div>
      <div className="flex flex-col gap-5 rounded-[20px] p-6" data-testid="share-landing"
           style={{ background: 'var(--surface)', boxShadow: '0 0 0 1px var(--line)' }}>
        {valid ? (
          <>
            <h1 className="text-[24px] font-bold leading-tight" style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
              A WebFloppy library was shared with you
            </h1>
            <p data-testid="landing-text" className="text-[14px]" style={{ color: 'var(--ink)' }}>
              A WebFloppy library was shared with you. Open your WebFloppy and paste this link in Remote › Add.
            </p>
            <LandingLink fallback={fallback} />
            <p className="text-[13px]" style={{ color: 'var(--muted)' }}>
              The link works once: the first WebFloppy to add it keeps it.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-[24px] font-bold leading-tight" style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>
              Not a share link
            </h1>
            <p data-testid="landing-text" className="text-[14px]" style={{ color: 'var(--ink)' }}>
              This address is not a whole share link. Ask the person who sent it for the full link.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
