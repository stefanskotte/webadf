import { notFound } from 'next/navigation';

// Development-only test page for the error boundary (e2e/states.spec.ts): the first request for a token fails, every
// later one renders, so "Try again" can be seen to re-fetch. A production build has no such page.
const seen = new Set<string>();

export default async function DevFailPage(props: PageProps<'/dev/fail'>) {
  if (process.env.NODE_ENV === 'production') notFound();
  const { once } = await props.searchParams;
  const token = typeof once === 'string' ? once : '';
  if (!seen.has(token)) {
    seen.add(token);
    throw new Error(`dev/fail: deliberate failure for token "${token}"`);
  }
  return <p data-testid="dev-fail-ok" className="px-7 pt-6" style={{ color: 'var(--on-dark)' }}>Loaded.</p>;
}
