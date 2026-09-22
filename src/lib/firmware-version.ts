import { z } from 'zod';

/**
 * The one bound on a firmware version string, shared by the registration
 * route and the status route.
 *
 * They used to disagree: registration accepted 50 characters and nothing else
 * had an opinion, because nothing else accepted the field at all. A board
 * that could register with a version it may not report would be a gap with no
 * reason to exist, and the firmware's own status-body budget
 * (DC_STATUS_VER_BYTES in wifi-floppy/firmware/src/device_client.h) is sized
 * from this number -- so it has to live in exactly one place.
 */
export const FIRMWARE_VERSION_MAX = 64;

export const firmwareVersionSchema = z.string().min(1).max(FIRMWARE_VERSION_MAX);

/**
 * The semver half of a version string, or null if it does not carry one.
 *
 * The grammar (`<semver>+<git identity>`) is produced by
 * wifi-floppy/firmware/cmake/gen_version_header.cmake and was being re-parsed
 * independently by the publish script and re-asserted by the publish rules.
 * It lives here so all three read the same definition, and so the test file
 * that already covers this string's length covers its shape too.
 */
export function semverOf(version: string): string | null {
  const [semver, ...rest] = version.split('+');
  if (rest.length !== 1) return null;       // no '+', or more than one
  if (!/^\d+\.\d+\.\d+$/.test(semver)) return null;
  return semver;
}

/**
 * Whether a version string identifies the source it was built from.
 *
 * Two spellings mean it does not: `-dirty` (built from uncommitted changes)
 * and `+nogit` (built where git was unavailable, so not even a base commit is
 * known). The second is the WORSE of the two and was originally missed,
 * because the rule was written as a string match on the first.
 */
export function identifiesItsSource(version: string): boolean {
  return !version.endsWith('-dirty') && !version.endsWith('+nogit');
}
