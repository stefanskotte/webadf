'use client';

import { useRef, useState } from 'react';
import { mainDrive } from '@/lib/drive-numbers';
import type { DeviceListItem } from '@/lib/queries';
import { panelHeight } from '@/lib/display-editor-geometry';
import { DriveArt } from './drive-art';
import { DriveGlass } from './drive-glass';
import { DisplayEditor } from './display-editor';

/**
 * The drive tile (spec §3): the board's drawing of the drive with its own screen on it. `device-bezel-<id>` is the old
 * bezel's id on the new element. Pressing the screen opens the display editor (spec §10), a modal mounted only while
 * open, so closing it discards unsaved edits; focus returns to the screen. The caption row ("Board display · 128x32",
 * Change display) moved into Board settings' Display section (2026-11-12), which opens the same editor.
 */
export function DriveFront({ device, online }: { device: DeviceListItem; online: boolean }) {
  const [open, setOpen] = useState(false);
  // Focus returns to the screen that was pressed (its own currentTarget, not document.activeElement, which Safari does
  // not move on a button click).
  const opener = useRef<HTMLElement | null>(null);
  const openDisplay = (from: HTMLElement) => { opener.current = from; setOpen(true); };
  const tall = panelHeight(device.displayPanel) === 64;
  const hasDisk = device.desiredSha256 !== null || device.mountedSha256 !== null;
  return (
    <div className="flex w-full min-w-0 shrink-0 flex-col md:w-[340px]">
      <div className="flex w-full flex-col items-center rounded-[16px] px-[18px] pb-[18px] pt-[22px]"
           style={{ background: 'var(--ground)' }} data-testid={`device-bezel-${device.id}`}>
        <div className="relative w-full" style={{ maxWidth: 304 }}>
          <DriveArt name={device.name} online={online} hasDisk={hasDisk} tall={tall} drive={mainDrive(device.driveBase)} />
          <DriveGlass device={device} online={online} onOpenDisplay={openDisplay} />
        </div>
      </div>
      {open && <DisplayEditor device={device} onOpenChange={setOpen} finalFocus={opener} />}
    </div>
  );
}
