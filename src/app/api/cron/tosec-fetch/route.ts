import { runTosecFetch } from '@/lib/tosec-fetch';

export const maxDuration = 300;

/** Monthly (vercel.ts): TOSEC's newest release, Amiga [ADF] DATs only (self-hosting P3 D6-D7). */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const result = await runTosecFetch();
  console.log('tosec-fetch:', JSON.stringify(result));
  return Response.json(result);
}
