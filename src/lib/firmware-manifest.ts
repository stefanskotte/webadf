/**
 * The exact bytes a release's signature covers (spec D4). The firmware builds
 * the same string in fw_verify.c; test/fw_fixture.h proves they agree.
 * Changing a single character here strands every board in the field.
 */
export const FIRMWARE_MAX_BYTES = 2 * 1024 * 1024;

export function firmwareManifest(m: { version: string; sequence: number; sha256: string; sizeBytes: number }): string {
  return `webadf-fw-v1\n${m.version}\n${m.sequence}\n${m.sha256}\n${m.sizeBytes}`;
}
