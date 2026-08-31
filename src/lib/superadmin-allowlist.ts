/**
 * Pure allowlist logic for requireSuperAdmin(). Split out of superadmin.ts
 * so it can be unit-tested under Vitest, which never sets DATABASE_URL:
 * superadmin.ts statically imports `@/lib/auth`, and `@/lib/auth` calls
 * getDb() as a module-level side effect (see src/db/index.ts), which throws
 * without DATABASE_URL. This module has no such dependency, so importing it
 * for tests is safe.
 *
 * This module reads no environment variables itself -- SUPERADMIN_EMAILS is
 * read in exactly one place, superadmin.ts, and passed in here as `raw`.
 * Keep it that way: exactly one file may read SUPERADMIN_EMAILS.
 */

/** Pure. Exported for tests; nothing else should call it. */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Printable ASCII only (0x21-0x7e; excludes space and control characters).
// Checked on the ORIGINAL string below, before toLowerCase() runs -- see the
// comment in isAllowed() for why the order matters.
const ASCII_ONLY = /^[\x21-\x7e]+$/;

/** Pure. The whole decision. */
export function isAllowed(email: string | undefined, raw: string | undefined): boolean {
  if (!email) return false;
  const trimmed = email.trim();
  // String#toLowerCase() is not injective over Unicode: distinct code points
  // can fold to the same lowercase string. E.g. U+212A KELVIN SIGN
  // lowercases to the ASCII letter 'k', so an address built with a Kelvin
  // sign in place of 'k' would otherwise compare equal to the real,
  // all-ASCII allowlisted address after lowercasing. The check MUST run on
  // the original (pre-lowercase) string: the Kelvin sign is non-ASCII before
  // folding but becomes indistinguishable ASCII 'k' after, so checking
  // post-lowercase would already be too late.
  //
  // Do NOT "fix" this with .normalize('NFKC') instead -- NFKC maps U+212A to
  // 'K' too, so it folds the Kelvin sign onto the ASCII letter even more
  // directly and makes this exact collision worse, not better.
  if (!ASCII_ONLY.test(trimmed)) return false;
  const normalized = trimmed.toLowerCase();
  const list = parseAllowlist(raw);
  // An empty allowlist denies everyone. The opposite default -- "nothing
  // configured, so allow" -- is a plausible reading of the same idea and
  // would hand every tenant's data to the first person who signs up.
  if (list.length === 0) return false;
  return list.includes(normalized);
}
