import { runFirmwareImport } from '@/lib/firmware-import';

export const maxDuration = 300;

/** Daily (vercel.ts): firmware releases from GitHub, verified as a board verifies them (self-hosting P3 D1-D3). */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const result = await runFirmwareImport();
  console.log('firmware-import:', JSON.stringify(result));
  return Response.json(result);
}
