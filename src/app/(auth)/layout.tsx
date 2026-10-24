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
 */
export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      {children}
    </main>
  );
}
