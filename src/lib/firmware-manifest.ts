/**
 * The exact bytes a release's signature covers (spec D4). The firmware builds
 * the same string in fw_verify.c; test/fw_fixture.h proves they agree.
 * Changing a single character here strands every board in the field.
 */
export const FIRMWARE_MAX_BYTES = 2 * 1024 * 1024;

export function firmwareManifest(m: { version: string; sequence: number; sha256: string; sizeBytes: number }): string {
  return `webadf-fw-v1\n${m.version}\n${m.sequence}\n${m.sha256}\n${m.sizeBytes}`;
}

/**
 * Spec D10: the one packaging mistake that removes the safety net is a release
 * without TBYB -- it boots unconditionally on update and can never revert. A
 * machine checks it, from picotool's own reading of the image.
 */
export function refuseReleaseImage(picotoolInfo: string, sizeBytes: number, bytes: Buffer): string | null {
  if (sizeBytes > FIRMWARE_MAX_BYTES) return `image is ${sizeBytes} bytes; the limit is 2 MB`;
  if (!/^\s*tbyb:\s+not bought\s*$/m.test(picotoolInfo)) {
    return 'image is not a TBYB (try-before-you-buy) image; build with PICO_CRT0_IMAGE_TYPE_TBYB=1';
  }
  // Exact line match, not a substring search: /hash/i also matched a path
  // that merely contained the word, and matched picotool's own "hash:
  // incorrect" -- printed for a PATCHED image whose hash the boot ROM would
  // then also reject, which is exactly the image this check exists to catch.
  if (!/^\s*hash:\s+verified\s*$/m.test(picotoolInfo)) {
    return 'image carries no hash for the boot ROM to check; build with pico_hash_binary';
  }
  if (bytes.includes(Buffer.from('fwdbg', 'ascii'))) return 'image contains the debug-only firmware command (WF_FW_DEBUG)';
  return null;
}
