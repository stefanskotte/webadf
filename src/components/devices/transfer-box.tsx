import type { ReactNode } from 'react';
import { Link } from '@/components/shell/link';
import { filesHrefForBoard } from '@/lib/files/path';

/**
 * The Transfer box (spec §7): whether Transfer runs on the Amiga, and the board's two ingest lines. `transfer` is
 * null for a board that cannot take files -- then there is no title row, only the lines. Both values of "running"
 * are words; the dot alone never carries it.
 */
export function TransferBox({ deviceId, transfer, sendLine, uploadLine, className = '' }: {
  deviceId: string; transfer: { running: boolean } | null; sendLine: string | null;
  uploadLine: { text: string; href: boolean } | null; className?: string;
}) {
  const idle = transfer !== null && !sendLine && !uploadLine;
  let upload: ReactNode = null;
  if (uploadLine) {
    upload = uploadLine.href ? (
      <Link href={filesHrefForBoard(deviceId, 'left')} data-testid={`device-upload-${deviceId}`}
            className="w-fit text-[12px] underline underline-offset-2" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>
        {uploadLine.text}
      </Link>
    ) : (
      <span data-testid={`device-upload-${deviceId}`} className="text-[12px]" style={{ color: 'var(--muted)', overflowWrap: 'anywhere' }}>
        {uploadLine.text}
      </span>
    );
  }
  return (
    <div className={`flex flex-col gap-[3px] rounded-[12px] px-3 py-2.5 ${className}`} style={{ background: 'var(--surface-2)' }}
         data-testid={`device-transfer-${deviceId}`}>
      {transfer && (
        <span className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--ink)' }}
              data-testid={`device-transfer-state-${deviceId}`} data-running={transfer.running ? 'true' : 'false'}>
          <span aria-hidden="true" className="box-border size-2 shrink-0 rounded-full"
                style={transfer.running
                  ? { background: 'var(--online-dot)' }
                  : { border: '1.5px solid var(--muted-2)' }} />
          {transfer.running ? 'Transfer is running on the Amiga' : 'Transfer is not running on the Amiga'}
        </span>
      )}
      {sendLine && (
        <Link href={filesHrefForBoard(deviceId, 'right')} data-testid={`device-send-${deviceId}`}
              className="w-fit text-[12px] underline underline-offset-2" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>
          {sendLine}
        </Link>
      )}
      {upload}
      {idle && (
        <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid={`device-transfer-idle-${deviceId}`}>
          Nothing waiting, and nothing from the Amiga in the last 24 hours.
        </span>
      )}
    </div>
  );
}
