import { describe, it, expect } from 'vitest';
import { lastBootSchema, describeLastBoot } from './last-boot';

// The boot trail (fw 1.18.2, wifi-floppy/firmware/src/boot_trail.h): the previous boot's last stage per core and
// why the chip reset. The card shows it only when the previous boot stopped where it should not have.
describe('lastBootSchema', () => {
  it('takes what the board sends', () => {
    expect(lastBootSchema.parse({ reset: 'watchdog', c0: 'i2c', up0: 3, c1: 'wifi', up1: 2 }))
      .toEqual({ reset: 'watchdog', c0: 'i2c', up0: 3, c1: 'wifi', up1: 2 });
    expect(lastBootSchema.parse({ reset: 'power-on' })).toEqual({ reset: 'power-on' });
    expect(lastBootSchema.parse({ reset: 'power-on', upd: 'i2c' })).toEqual({ reset: 'power-on', upd: 'i2c' });
    expect(lastBootSchema.parse({ reset: 'watchdog', c0: 'psram-init', up0: 0, c1: 'proven', up1: 30 }).c0)
      .toBe('psram-init');
  });
  it('refuses unknown words and out-of-range numbers', () => {
    expect(lastBootSchema.safeParse({ reset: 'meltdown' }).success).toBe(false);
    expect(lastBootSchema.safeParse({ reset: 'watchdog', c0: 'warp' }).success).toBe(false);
    expect(lastBootSchema.safeParse({ reset: 'watchdog', c0: 'i2c', up0: 70000 }).success).toBe(false);
  });
});

describe('describeLastBoot', () => {
  it('a boot that found the I2C bus held says so, whatever ended it (fix round 1)', () => {
    expect(describeLastBoot({ reset: 'software', c0: 'reboot', up0: 900, i2cHeld: true, c1: 'contact', up1: 899 }))
      .toBe('Previous start found the I2C bus held low: display and NFC were off (reset: software)');
    expect(lastBootSchema.safeParse({ reset: 'watchdog', i2cHeld: 'yes' }).success).toBe(false);
  });
  it('an update restart that a power cut ended is named from the flash trail', () => {
    expect(describeLastBoot({ reset: 'power-on', upd: 'i2c' }))
      .toBe("Last update's restart got as far as: the I2C scan (reset: power-on)");
    expect(describeLastBoot({ reset: 'power-on', upd: 'buy' }))
      .toBe("Last update's restart got as far as: the confirm request (reset: power-on)");
  });
  it('says nothing for a clean history', () => {
    expect(describeLastBoot(null)).toBeNull();
    expect(describeLastBoot({ reset: 'power-on' })).toBeNull();                      // nothing survives a power-up
    expect(describeLastBoot({ reset: 'software', c0: 'reboot', up0: 40, c1: 'contact', up1: 39 })).toBeNull();
    expect(describeLastBoot({ reset: 'software', c0: 'reboot', up0: 40, c1: 'proven', up1: 39 })).toBeNull();
  });
  it('names where a start stopped, core0 first', () => {
    expect(describeLastBoot({ reset: 'watchdog', c0: 'nfc', up0: 1, c1: 'wifi', up1: 1 }))
      .toBe('Previous start stopped at: NFC probe (reset: watchdog)');
    expect(describeLastBoot({ reset: 'watchdog', c0: 'i2c', up0: 0 }))
      .toBe('Previous start stopped at: I2C scan (reset: watchdog)');
    expect(describeLastBoot({ reset: 'watchdog', c0: 'bought', up0: 0 }))
      .toBe('Previous start stopped at: after the firmware buy (reset: watchdog)');
    expect(describeLastBoot({ reset: 'watchdog', c0: 'loop', up0: 60, c1: 'loop', up1: 59 }))
      .toBe('Previous start stopped at: first server report (reset: watchdog)');
    expect(describeLastBoot({ reset: 'watchdog', c0: 'loop', up0: 60, c1: 'trial', up1: 59 }))
      .toBe('Previous start stopped at: update trial (reset: watchdog)');
    expect(describeLastBoot({ reset: 'brown-out', c0: 'loop', up0: 9, c1: 'server', up1: 8 }))
      .toBe('Previous start stopped at: server connection (reset: brown-out)');
  });
  it('a core1 stall (fw 1.21.0) says the network side stopped, and how long the board had run', () => {
    const lb = lastBootSchema.parse({ reset: 'core1-stall', c0: 'c1-stall', up0: 3700, c1: 'contact', up1: 3640 });
    expect(describeLastBoot(lb))
      .toBe('Previous run: the network side stopped responding after 1 h 0 min; the board restarted itself (reset: core1-stall)');
    // Before its first server report: still the network side, named by where core1 was.
    expect(describeLastBoot({ reset: 'core1-stall', c0: 'c1-stall', up0: 200, c1: 'loop', up1: 130 }))
      .toBe('Previous run: the network side stopped responding after 2 min; the board restarted itself (reset: core1-stall)');
  });
  it('a run that was cut short by an unasked reset says how long it ran', () => {
    expect(describeLastBoot({ reset: 'watchdog', c0: 'loop', up0: 36125, c1: 'contact', up1: 36100 }))
      .toBe('Previous run stopped after 10 h 2 min (reset: watchdog)');
    expect(describeLastBoot({ reset: 'unknown', c0: 'loop', up0: 125, c1: 'contact', up1: 100 }))
      .toBe('Previous run stopped after 2 min (reset: unknown)');
  });
});
