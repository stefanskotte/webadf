import type { NextRequest } from 'next/server';
import { ingestRedirect } from '@/lib/files/ingest-redirect';

// The Upload page retired into the Files page (Files spec 2026-10-29 §5.3, increment 3 R10): a bookmark, an old link
// or a stored "See queue" still lands on the right panes. A route handler, not a page: a page's redirect() streams
// under (app)/loading.tsx and arrives as a 200 with a meta refresh, and next.config's redirects() would carry the old
// ?board= along and cannot say "board wins over from". 307, not 308: browsers cache a 308 for good. The Location is
// relative, so it holds behind any proxy; signed out, src/proxy.ts has already sent the visitor to /sign-in.
export async function GET(request: NextRequest) {
  const sp: Record<string, string | string[]> = {};
  for (const key of new Set(request.nextUrl.searchParams.keys())) {
    const all = request.nextUrl.searchParams.getAll(key);
    sp[key] = all.length === 1 ? all[0] : all;
  }
  return new Response(null, { status: 307, headers: { Location: ingestRedirect(sp) } });
}
