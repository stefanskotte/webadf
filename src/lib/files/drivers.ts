// src/lib/files/drivers.ts
// Which driver serves a device: LIBRARY:, STASH: and (increment 3) NET:. SERVER ONLY.
import type { Device } from './path';
import type { VolumeDriver } from './driver';
import { libraryDriver } from './library-driver';
import { stashDriver } from './stash-driver';
import { netDriver } from './net-driver';

const DRIVERS: Record<Device, VolumeDriver> = { LIBRARY: libraryDriver, STASH: stashDriver, NET: netDriver };

export function driverFor(device: Device): VolumeDriver | null {
  return DRIVERS[device] ?? null;
}
