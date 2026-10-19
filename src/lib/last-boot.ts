import { z } from 'zod';

/**
 * The boot trail (fw 1.18.2, wifi-floppy/firmware/src/boot_trail.h): on its first status report after a start,
 * the board says how far each core got in the PREVIOUS boot and why the chip reset. The trail lives in registers a
 * watchdog or software reset keeps and a power-up clears, so a hang the watchdog ended is reported with its stage;
 * one ended by pulling the power arrives as {reset:'power-on'} with no stage. Stored in devices.last_boot.
 */
export const LAST_BOOT_RESETS = [
  'power-on', 'brown-out', 'run-pin', 'debugger', 'glitch', 'watchdog', 'software', 'sysreset', 'unknown',
] as const;
const C0 = ['early', 'buy', 'bought', 'psram-init', 'psram', 'i2c', 'display', 'nfc', 'loop', 'reboot'] as const;
const C1 = ['start', 'wifi', 'server', 'trial', 'proven', 'loop', 'contact'] as const;
/** The flash update trail (boot_trail.h UT_*): how far an update's confirm restart got -- it survives a power cut. */
const UPD = ['buy', 'psram', 'i2c', 'display', 'launch', 'server', 'contact'] as const;
const up = z.number().int().min(0).max(0xffff);

export const lastBootSchema = z.object({
  reset: z.enum(LAST_BOOT_RESETS),
  c0: z.enum(C0).optional(),
  up0: up.optional(),
  c1: z.enum(C1).optional(),
  up1: up.optional(),
  upd: z.enum(UPD).optional(),
});
export type LastBoot = z.infer<typeof lastBootSchema>;

// Where it stopped: the stage it had reached and not left.
const C0_LABEL: Record<(typeof C0)[number], string> = {
  early: 'firmware start', buy: 'firmware buy', bought: 'after the firmware buy', 'psram-init': 'memory init',
  psram: 'after memory init', i2c: 'I2C scan', display: 'display init', nfc: 'NFC probe', loop: 'running',
  reboot: 'restart',
};
const C1_LABEL: Record<(typeof C1)[number], string> = {
  start: 'radio start', wifi: 'Wi-Fi', server: 'server connection', trial: 'update trial', proven: 'confirm restart',
  loop: 'first server report', contact: 'running',
};
// The last mark the flash trail holds, as the point the restart got to.
const UPD_LABEL: Record<(typeof UPD)[number], string> = {
  buy: 'the confirm request', psram: 'the buy and memory init', i2c: 'the I2C scan', display: 'the display and NFC setup',
  launch: 'the Wi-Fi start', server: 'the server connection', contact: 'running',
};

function duration(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/**
 * The card's line, or null when the previous boot ended the way boots should: a power-up (nothing is known), or a
 * restart the firmware asked for. Otherwise core0's stage if it had not reached its loop, then core1's, and for a
 * board that was fully running, how long it ran before the reset nobody asked for.
 */
export function describeLastBoot(lb: LastBoot | null): string | null {
  if (!lb) return null;
  const why = `(reset: ${lb.reset})`;
  // An update's confirm restart the flash trail saw stop (usually ended by a power cut, which wipes the rest).
  if (lb.upd && lb.upd !== 'contact') return `Last update's restart got as far as: ${UPD_LABEL[lb.upd]} ${why}`;
  if (lb.reset === 'software' || lb.c0 === 'reboot' || (!lb.c0 && !lb.c1)) return null;
  if (lb.c0 && lb.c0 !== 'loop') return `Previous start stopped at: ${C0_LABEL[lb.c0]} ${why}`;
  if (lb.c1 && lb.c1 !== 'contact') return `Previous start stopped at: ${C1_LABEL[lb.c1]} ${why}`;
  return `Previous run stopped after ${duration(Math.max(lb.up0 ?? 0, lb.up1 ?? 0))} ${why}`;
}
