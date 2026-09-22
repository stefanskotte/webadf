import { z } from 'zod';

/**
 * What a device may report about an update in flight.
 *
 * There is deliberately no 'succeeded'. Completion is derived in recordStatus
 * from the version the board actually reports running: a device that reports
 * success is a device that can be wrong about it, and the version it is
 * running is evidence it produces by running rather than by claiming.
 */
export const UPDATE_STATES = ['queued', 'downloading', 'applying', 'failed'] as const;
export type UpdateState = typeof UPDATE_STATES[number];

export const updateStateSchema = z.enum(UPDATE_STATES);

/**
 * The device's own statement of what it can do. Bounded rather than any
 * integer: a level of 9999 could only come from a confused board, and
 * accepting it would let the UI offer an update to something that cannot
 * take one.
 */
export const updateProtocolSchema = z.number().int().min(0).max(15);
