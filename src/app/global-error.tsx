'use client';

import { useEffect } from 'react';

// The root layout itself failed (A1 States). Next renders this INSTEAD of it: no globals.css, no fonts, no shell --
// so it brings its own <html>, <body> and plain inline styles, and says the same as every other error card.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', background: '#F3EFE6', color: '#24211B', fontFamily: 'system-ui, sans-serif' }}>
        <main role="alert" data-testid="error-page" style={{ maxWidth: 520, margin: '15vh auto 0', padding: '0 16px' }}>
          <h1 style={{ fontSize: 22, margin: '0 0 12px' }}>This page didn&apos;t load</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: '#5B5446', margin: '0 0 20px' }}>
            Something went wrong on our side. Your disks are safe; nothing was changed.
          </p>
          <button
            type="button"
            data-testid="error-retry"
            onClick={() => retry()}
            style={{ border: 0, borderRadius: 999, padding: '7px 16px', fontSize: 13, fontWeight: 600, color: '#fff', background: '#24211B', cursor: 'pointer' }}
          >
            Try again
          </button>
          {error.digest && (
            <p data-testid="error-reference" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: '#6E6657', marginTop: 16 }}>
              Reference: {error.digest}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
