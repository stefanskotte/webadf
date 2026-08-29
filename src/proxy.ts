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
export const config = { matcher: ['/library/:path*', '/ingest/:path*', '/devices/:path*'] };
