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

export const config = { matcher: ['/library/:path*', '/ingest/:path*'] };
