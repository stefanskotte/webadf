'use client';

import { useState } from 'react';
import type { DeviceListItem } from '@/lib/queries';
import { DriveBezel } from './drive-bezel';
import { DisplayEditor } from './display-editor';

/**
 * The bezel and the Display drawer under it, which share one open state: the
 * bezel dims and squares its corners while the drawer is out.
 */
export function DriveFront({ device, online }: { device: DeviceListItem; online: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col">
      <DriveBezel device={device} online={online} drawerOpen={open} onOpenDisplay={() => setOpen(true)} />
      <DisplayEditor device={device} open={open} onOpenChange={setOpen} />
    </div>
  );
}
