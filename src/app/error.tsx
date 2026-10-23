'use client';

import { ErrorView } from '@/components/shell/error-view';

// A shell itself failed (the app or admin layout: the header's own queries), so there is no header to keep. Still
// inside the root layout, so the page has its styles; only a failure of the root layout reaches global-error.tsx.
export default function RootError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView error={error} retry={retry} homeHref="/library" homeLabel="Back to the library" />;
}
