import { Logo } from '@/components/shell/logo';
import { DiskIcon } from '@/components/ui/disk-icon';

/**
 * The frame /sign-in and /sign-up never had.
 *
 * These two are the only pages in the app with no shell and no glass surface:
 * they rendered a bare form straight onto `bg-page-gradient`, whose top stop
 * is `--grad-top` (#1b2534), while shadcn's defaults paint text in
 * `--foreground` (#252525) because they assume a white page. That is a
 * measured contrast of **1.01:1** — the heading and the first label were not
 * "hard to read", they were the same colour as what sat behind them. Lower
 * fields drifted into legible territory as the gradient lightened, which is
 * why it looked like a partial problem rather than a total one, and why it
 * changed with the window height.
 *
 * Centring is half the fix and the panel is the other half, and both are
 * needed: centring moves the form off the darkest inch, and the panel then
 * guarantees legibility wherever it actually lands, so none of this quietly
 * depends on the viewport being tall enough.
 *
 * Since Phase B (2026-10-24) the page is the flat cream ground (`bg-page`,
 * `--ground`) and the gradient is gone; the history above is why the frame
 * exists, and the centred panel stays.
 *
 * Since C5 (2026-10-25) the frame is the board's split page from lg (InfSignIn): an ink hero beside the form; below lg
 * a logo row above the form.
 */
export default function AuthLayout({ children }: LayoutProps<'/'>) {
  const display = { fontFamily: 'var(--font-display)' };
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1fr)_560px]" style={{ background: 'var(--ground)' }}>
      <section aria-label="About WebFloppy" data-testid="auth-hero" className="hidden flex-col justify-between p-16 lg:flex"
               style={{ background: 'var(--ink)', color: 'var(--surface)' }}>
        <div className="flex items-center gap-2.5">
          <Logo size={34} tone="light" />
          <span className="text-[24px] font-bold tracking-[-0.02em]" style={display}>webfloppy</span>
        </div>
        <div className="flex flex-col gap-7">
          {/* Decoration with neutral labels (Ruling 32). Each disk sits in its own positioned box: DiskIcon's root is
              position:relative, which would override an `absolute` class on it. */}
          <div aria-hidden className="relative h-[200px]">
            <div className="absolute left-0 top-8 -rotate-[10deg]">
              <DiskIcon size={130} color="red" stack={6} set="Your games" title="Six-disk game" />
            </div>
            <div className="absolute left-[130px] top-0 rotate-[4deg]">
              <DiskIcon size={150} color="blue" set="Saves come back" title="Version 8" />
            </div>
            <div className="absolute left-[290px] top-10 rotate-[14deg]">
              <DiskIcon size={120} color="green" wp set="Utilities" title="Workbench" />
            </div>
          </div>
          {/* A paragraph set large, not a heading (Ruling 30): the form's h1 is the page's one heading. */}
          <p data-hero="tagline" className="max-w-[560px] text-[52px] font-bold leading-[1.02] tracking-[-0.02em]" style={display}>
            Your Amiga disks, on a floppy drive that lives on the network.
          </p>
          <p data-hero="sub" className="max-w-[520px] text-[16px] leading-[1.55]" style={{ color: 'var(--on-ink-2)' }}>
            Keep the library here, mount any disk in DF0 from your phone, and get every save back as a new version.
          </p>
        </div>
        {/* Ruling 33: no external link (self-host parity), no our-deployment-only words. */}
        <p data-hero="foot" className="text-[13px]" style={{ color: 'var(--on-ink-muted)' }}>
          Invite-only — ask the person who runs this server for a code.
        </p>
      </section>
      <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col justify-center gap-6 px-4 py-10 sm:p-10 lg:min-h-0 lg:max-w-none lg:p-16">
        <div className="flex items-center gap-2.5 lg:hidden">
          <Logo size={26} />
          <span className="text-[20px] font-bold tracking-[-0.02em]" style={{ ...display, color: 'var(--ink)' }}>webfloppy</span>
        </div>
        {children}
      </main>
    </div>
  );
}
