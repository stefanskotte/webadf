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
