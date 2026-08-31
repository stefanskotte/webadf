import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

export function proxy(request: NextRequest) {
  // Optimistic cookie check only — NOT authoritative. Every page still calls
  // requireOrg(), which is what actually enforces access.
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/sign-in', request.url));
  }
  return NextResponse.next();
}

// '/devices/:path*' guards the (future) human-facing devices page, not the
// device plane's own API. It does NOT match '/api/devices/pair' or
// '/api/device/register' -- those start with '/api', a different first path
// segment -- so this optimistic cookie check never runs in front of routes
// that authenticate in-handler by bearer token or by pairing code.
// '/admin/:path*' gets the same optimistic cookie check as the rest: it only
// bounces a visitor with no session cookie at all to /sign-in, and knows
// nothing about the allowlist. requireSuperAdmin() in the (admin) layout is
// what actually enforces admin access, and it redirects a signed-in non-admin
// to /library rather than 404ing so the response never confirms /admin exists.
export const config = {
  matcher: ['/library/:path*', '/ingest/:path*', '/devices/:path*', '/admin/:path*'],
};
