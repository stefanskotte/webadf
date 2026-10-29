// src/lib/files/drivers.ts
// Which driver serves a device. NET: arrives in increment 3. SERVER ONLY.
import type { Device } from './path';
import type { VolumeDriver } from './driver';
import { libraryDriver } from './library-driver';
import { stashDriver } from './stash-driver';

const DRIVERS: Partial<Record<Device, VolumeDriver>> = { LIBRARY: libraryDriver, STASH: stashDriver };

export function driverFor(device: Device): VolumeDriver | null {
  return DRIVERS[device] ?? null;
}
