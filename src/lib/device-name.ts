// No database import here: device-card and drive-chips (client components) use
// these helpers, and the query that renames lives in device-rename.ts.

/**
 * The label a device carries until a human gives it one.
 *
 * `devices.name` is NOT NULL and has always held this, written by
 * /api/device/register from the one identifying detail the device itself
 * supplies. Naming it here rather than inlining the template twice is the
 * point: register writes it, and clearing an alias restores it, so the two
 * must agree or a "reset" would produce a label the device never had.
 *
 * The MAC is not lost by renaming -- `devices.macAddress` is its own column,
 * and the devices page shows it beside the name regardless.
 */
export function defaultDeviceName(macAddress: string | null): string {
  // A device that somehow registered without a MAC still needs a non-null
  // label, and "Device null" is not it.
  return macAddress ? `Device ${macAddress}` : 'Device';
}

/** True when `name` is just the stand-in, i.e. nobody has named this drive. */
export function isDefaultDeviceName(name: string, macAddress: string | null): boolean {
  return name === defaultDeviceName(macAddress);
}
