// src/lib/files/drivers.ts
// Which driver serves a device. STASH: arrives in increment 2 Task 4, NET: in increment 3. SERVER ONLY.
import type { Device } from './path';
import type { VolumeDriver } from './driver';
import { libraryDriver } from './library-driver';

const DRIVERS: Partial<Record<Device, VolumeDriver>> = { LIBRARY: libraryDriver };

export function driverFor(device: Device): VolumeDriver | null {
  return DRIVERS[device] ?? null;
}
