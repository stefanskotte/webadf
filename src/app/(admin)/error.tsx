'use client';

import { ErrorView } from '@/components/shell/error-view';

// A page under the admin shell failed: the admin header stays (A1 States).
export default function AdminError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView error={error} retry={retry} homeHref="/admin" homeLabel="Back to admin" />;
}
