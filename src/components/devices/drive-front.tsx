'use client';

import { useState } from 'react';
import type { DeviceListItem } from '@/lib/queries';
import { panelHeight } from '@/lib/display-editor-geometry';
import { HelpTip } from '@/components/help/help-tip';
import { DriveArt } from './drive-art';
import { DriveGlass } from './drive-glass';
import { DisplayEditor } from './display-editor';

/**
 * The drive tile (spec §3): the board's drawing of the drive with its own screen on it, and the caption row that
 * names the panel and opens the display editor. `device-bezel-<id>` is the old bezel's id on the new element. The
 * editor still opens as today's drawer under the tile; Task 6 makes it a modal.
 */
export function DriveFront({ device, online }: { device: DeviceListItem; online: boolean }) {
  const [open, setOpen] = useState(false);
  const tall = panelHeight(device.displayPanel) === 64;
  const hasDisk = device.desiredSha256 !== null || device.mountedSha256 !== null;
  return (
    <div className="flex w-full min-w-0 shrink-0 flex-col md:w-[340px]">
      <div className="flex w-full flex-col items-center gap-3.5 rounded-[16px] px-[18px] pb-[18px] pt-[22px]"
           style={{ background: 'var(--ground)' }} data-testid={`device-bezel-${device.id}`}>
        <div className="relative w-full" style={{ maxWidth: 304 }}>
          <DriveArt name={device.name} online={online} hasDisk={hasDisk} tall={tall} />
          <DriveGlass device={device} online={online} onOpenDisplay={() => setOpen(true)} />
        </div>
        <div className="flex w-full items-center justify-between text-[12px]" style={{ color: 'var(--muted-2)' }}>
          <span>Board display · {tall ? '128×64' : '128×32'}</span>
          <span className="flex items-center gap-1">
            <button type="button" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open}
                    data-testid={`display-toggle-${device.id}`}
                    className="flex h-7 items-center gap-1.5 rounded-[7px] px-2 text-[12px] font-semibold"
                    style={{ color: 'var(--ink)' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8M12 17v4" />
              </svg>
              Change display
            </button>
            <HelpTip topic="display" />
          </span>
        </div>
      </div>
      <DisplayEditor device={device} open={open} onOpenChange={setOpen} />
    </div>
  );
}
