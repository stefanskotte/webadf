import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';
import { warnOnOrigin } from '@/selfhost/origin-warn';

const h = toNextJsHandler(auth);
export const GET = (req: Request) => { warnOnOrigin(req); return h.GET(req); };
export const POST = (req: Request) => { warnOnOrigin(req); return h.POST(req); };
