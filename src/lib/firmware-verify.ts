import { createHash, verify } from 'node:crypto';
import { firmwareManifest, FIRMWARE_MAX_BYTES } from './firmware-manifest';
import { firmwareVersionSchema, semverOf } from './firmware-version';
import { publicKeyFor, FIRMWARE_PUBLIC_KEYS } from './firmware-keys';

/** A GitHub release's manifest.json (firmware-github-release.ts), checked as a board would (spec P3 D2). */
export interface ReleaseManifest {
  version: string; semver: string; sequence: number; file: string; sha256: string;
  signature: string; signingKeyId: string; signatureFormat: number;
  notes?: string | null; security?: boolean;
}

export function parseReleaseManifest(j: unknown): ReleaseManifest | string {
  const o = j as Record<string, unknown>;
  const str = (k: string) => typeof o?.[k] === 'string' && (o[k] as string).length > 0;
  if (!o || !['version', 'semver', 'file', 'sha256', 'signature', 'signingKeyId'].every(str)
    || !Number.isInteger(o.sequence) || !Number.isInteger(o.signatureFormat)) {
    return 'manifest.json is missing version, semver, sequence, file, sha256, signature, signingKeyId or signatureFormat';
  }
  return {
    version: o.version as string, semver: o.semver as string, sequence: o.sequence as number, file: o.file as string,
    sha256: o.sha256 as string, signature: o.signature as string, signingKeyId: o.signingKeyId as string,
    signatureFormat: o.signatureFormat as number,
    notes: typeof o.notes === 'string' ? o.notes : o.notes === null ? null : undefined,
    security: typeof o.security === 'boolean' ? o.security : undefined,
  };
}

/** Field shapes exactly as the board's fw_offer.c checks them; null = fine. */
function fieldProblem(m: ReleaseManifest): string | null {
  const v = m.version;
  if (!firmwareVersionSchema.safeParse(v).success || v.startsWith('.') || !/^[A-Za-z0-9.+-]+$/.test(v)
    || !/[A-Za-z0-9]/.test(v) || semverOf(v) === null) return `version ${JSON.stringify(v)} is not a path-safe <semver>+<build> version`;
  if (m.semver !== semverOf(v)) return `semver ${m.semver} is not the semver half of version ${v}`;
  if (!Number.isSafeInteger(m.sequence) || m.sequence < 1 || m.sequence > 0xffffffff) return `sequence ${m.sequence} is outside 1..4294967295`;
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) return 'sha256 is not 64 lowercase hex characters';
  if (!/^[A-Za-z0-9+/]{86}==$/.test(m.signature)) return 'signature is not canonical base64 of 64 bytes';
  const sig = Buffer.from(m.signature, 'base64');
  if (sig.length !== 64 || sig.toString('base64') !== m.signature) return 'signature is not canonical base64 of 64 bytes';
  return null;
}

export function verifyRelease(m: ReleaseManifest, bin: Buffer, keys = FIRMWARE_PUBLIC_KEYS): string | null {
  if (m.file !== 'wifi_floppy.bin') return `manifest names ${m.file}; only wifi_floppy.bin is a release image`;
  if (m.signatureFormat !== 2) return `signatureFormat ${m.signatureFormat}; boards accept 2`;
  const bad = fieldProblem(m);
  if (bad) return bad;
  if (bin.length === 0) return 'image is empty';
  if (bin.length > FIRMWARE_MAX_BYTES) return `image is ${bin.length} bytes; the limit is 2 MB`;
  const sha = createHash('sha256').update(bin).digest('hex');
  if (sha !== m.sha256) return `wifi_floppy.bin sha256 ${sha} is not the manifest's ${m.sha256}`;
  const key = publicKeyFor(m.signingKeyId, keys);
  if (!key) return `unknown signing key ${m.signingKeyId}`;
  const msg = firmwareManifest({ version: m.version, sequence: m.sequence, sha256: m.sha256, sizeBytes: bin.length });
  if (!verify(null, Buffer.from(msg, 'ascii'), key, Buffer.from(m.signature, 'base64'))) {
    return 'signature does not verify with the boards\' key';
  }
  return null;
}
