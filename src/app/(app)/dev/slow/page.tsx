import { notFound } from 'next/navigation';

// Development-only test page for the loading placeholders (e2e/states.spec.ts): renders after `?ms=` (at most 5 s),
// so the app's loading.tsx is on screen meanwhile. A production build has no such page.
export default async function DevSlowPage(props: PageProps<'/dev/slow'>) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { ms } = await props.searchParams;
  await new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 5000)));
  return <p data-testid="dev-slow-ok" className="px-7 pt-6" style={{ color: 'var(--on-dark)' }}>Loaded.</p>;
}
