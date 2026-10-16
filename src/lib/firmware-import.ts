import { inArray, asc } from 'drizzle-orm';
import { getDb } from '@/db';
import { firmwareReleases } from '@/db/schema/firmware';
import { user } from '@/db/schema/auth';
import { firmwareStore } from '@/lib/storage';
import { parseAllowlist } from '@/lib/superadmin-allowlist';
import { importRelease } from '@/lib/firmware-releases';
import { parseReleaseManifest, verifyRelease, type ReleaseManifest } from '@/lib/firmware-verify';
import { FIRMWARE_PUBLIC_KEYS } from '@/lib/firmware-keys';
import { webadfUserAgent } from '@/lib/user-agent';

export interface FirmwareImportResult { imported: string[]; skipped: { tag: string; reason: string }[]; waiting?: string; error?: string }
const TAG = /^fw-(\d+\.\d+\.\d+)$/;
// githubReleasePlan's body: "wifi-floppy firmware <v> (sequence N)." / notes / "First install: ..." / boilerplate.
const HEADER = /^wifi-floppy firmware [^\n]*\(sequence \d+\)\.[ \t]*(\r?\n|$)/;
const AFTER_NOTES = /^(First install:|wifi_floppy\.bin is the signed image)/m;

/** The notes the publisher wrote, without the header line and boilerplate githubReleasePlan wraps around them. */
export function notesFromBody(body: string | null): string | null {
  if (!body) return null;
  const rest = body.replace(HEADER, '');
  const m = AFTER_NOTES.exec(rest);
  const notes = (m ? rest.slice(0, m.index) : rest).trim();
  return notes || null;
}

interface GhRelease { tag_name: string; body: string | null; draft: boolean; prerelease: boolean; assets: { name: string; browser_download_url: string }[] }

export async function runFirmwareImport(opts: {
  repo?: string; fetchImpl?: typeof fetch; keys?: Readonly<Record<string, string>>; log?: (l: string) => void;
} = {}): Promise<FirmwareImportResult> {
  const repo = opts.repo ?? process.env.WEBADF_FIRMWARE_REPO ?? 'stefanskotte/webadf';
  const f = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((l) => console.log(l));
  const ua = webadfUserAgent();
  const headers = { accept: 'application/vnd.github+json', 'user-agent': ua };
  const result: FirmwareImportResult = { imported: [], skipped: [] };
  const db = getDb();

  const admins = parseAllowlist(process.env.SUPERADMIN_EMAILS);
  const [publisher] = admins.length
    ? await db.select({ id: user.id }).from(user).where(inArray(user.email, admins)).orderBy(asc(user.createdAt)).limit(1)
    : [];
  if (!publisher) { result.waiting = 'no super-admin has signed up yet; firmware import waits'; log(`firmware import: ${result.waiting}`); return result; }

  let releases: GhRelease[];
  try {
    const r = await f(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
    if (!r.ok) {
      const limited = r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0';
      throw new Error(limited ? 'GitHub API rate limit reached' : `GitHub API answered ${r.status}`);
    }
    releases = await r.json() as GhRelease[];
  } catch (e) {
    result.error = (e as Error).message; log(`firmware import: ${result.error}; retrying at the next run`); return result;
  }

  const known = new Set((await db.select({ semver: firmwareReleases.semver }).from(firmwareReleases)).map((r) => r.semver));
  const candidates: { tag: string; m: ReleaseManifest; bin: Buffer; body: string | null }[] = [];
  for (const rel of releases) {
    const t = TAG.exec(rel.tag_name);
    if (!t || rel.draft || rel.prerelease || known.has(t[1])) continue;
    const skip = (reason: string) => { result.skipped.push({ tag: rel.tag_name, reason }); log(`firmware import: ${rel.tag_name}: ${reason}`); };
    const asset = (name: string) => rel.assets.find((a) => a.name === name)?.browser_download_url;
    const mUrl = asset('manifest.json');
    if (!mUrl) { skip('no manifest.json'); continue; }
    try {
      const m = parseReleaseManifest(await (await f(mUrl, { headers: { 'user-agent': ua } })).json());
      if (typeof m === 'string') { skip(m); continue; }
      const binUrl = asset(m.file);
      if (!binUrl) { skip(`no ${m.file} asset`); continue; }
      const res = await f(binUrl, { headers: { 'user-agent': ua } });
      if (!res.ok) { skip(`${m.file} download answered ${res.status}`); continue; }
      const bin = Buffer.from(await res.arrayBuffer());
      const bad = verifyRelease(m, bin, opts.keys ?? FIRMWARE_PUBLIC_KEYS);
      if (bad) { skip(bad); continue; }
      if (m.semver !== t[1]) { skip(`tag ${rel.tag_name} but manifest semver ${m.semver}`); continue; }
      candidates.push({ tag: rel.tag_name, m, bin, body: rel.body });
    } catch (e) { skip((e as Error).message); }
  }

  for (const c of candidates.sort((a, b) => a.m.sequence - b.m.sequence)) {
    const blobPath = `firmware/${c.m.version}.bin`;
    if (!(await firmwareStore.stat(blobPath))) await firmwareStore.put(blobPath, c.bin);
    const ok = await importRelease({
      version: c.m.version, semver: c.m.semver, sequence: c.m.sequence, sha256: c.m.sha256, sizeBytes: c.bin.length,
      blobPath, signature: c.m.signature, signingKeyId: c.m.signingKeyId, signatureFormat: c.m.signatureFormat,
      notes: c.m.notes !== undefined ? c.m.notes : notesFromBody(c.body), security: c.m.security ?? false,
    }, publisher.id);
    if (ok) { result.imported.push(c.m.version); log(`firmware import: ${c.tag} imported as ${c.m.version} (sequence ${c.m.sequence})`); }
    else result.skipped.push({ tag: c.tag, reason: 'version or sequence already present' });
  }
  return result;
}
