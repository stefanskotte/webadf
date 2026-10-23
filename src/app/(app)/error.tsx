'use client';

import { ErrorView } from '@/components/shell/error-view';

// A page under the app shell failed: the header stays, the page body becomes the error card (A1 States).
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView error={error} retry={retry} homeHref="/library" homeLabel="Back to the library" />;
}
