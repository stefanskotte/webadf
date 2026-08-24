import { z } from 'zod';

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const MAX_BATCH = 500;

export const checkBody = z.object({
  hashes: z.array(z.string().regex(SHA256_RE)).min(1).max(MAX_BATCH),
});

export const presignBody = z.object({
  files: z.array(z.object({
    sha256: z.string().regex(SHA256_RE),
    sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
  })).min(1).max(MAX_BATCH),
});

export const completeBody = z.object({
  files: z.array(z.object({
    sha256: z.string().regex(SHA256_RE),
    sizeBytes: z.number().int().positive().max(2 * 1024 * 1024),
    filename: z.string().min(1).max(255),
  })).min(1).max(MAX_BATCH),
});

export function splitKnownMissing(requested: string[], known: Set<string>) {
  const seen = new Set<string>();
  const out = { known: [] as string[], missing: [] as string[] };
  for (const h of requested) {
    if (seen.has(h)) continue;
    seen.add(h);
    (known.has(h) ? out.known : out.missing).push(h);
  }
  return out;
}
