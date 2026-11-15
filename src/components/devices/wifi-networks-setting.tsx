'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DeviceListItem } from '@/lib/queries';
import { isOnline } from '@/lib/device-state';
import { FULL, setupSteps, wifiSection, type WifiAction } from '@/lib/wifi-networks';
import { HelpTip } from '@/components/help/help-tip';

const TICK_MS = 15_000;

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Board settings > Wi-Fi networks (2026-11-15, src/lib/wifi-networks.ts). Unlike the rest of the dialog it does not
 * wait for "Save to board": each button is a request the board picks up at once (as Change display saves on its
 * own), and the section shows what the board did -- the list and the setup page as the board last reported them.
 *
 * Both values of each state (HANDOFF rule): every network reads "Connected now" or "Saved"; the setup page reads
 * "Open until HH:MM" or "Closed"; a request reads "Waiting for the board" until the board answers. A firmware that
 * does not report its networks gets one line saying so, and no controls.
 */
export function WifiNetworksSetting({ device, serverNow, busy = false }: {
  device: DeviceListItem;
  /** The page's clock (device-card's `now`): the first render's, then ticked here. */
  serverNow: number;
  /** The dialog's own save is running. */
  busy?: boolean;
}) {
  const id = device.id;
  const router = useRouter();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  const now = Math.max(serverNow, tick);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const online = isOnline(device.lastSeenAt, now);
  const s = wifiSection(device, online, now);

  async function send(action: WifiAction, ssid?: string) {
    setSending(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/devices/${id}/wifi`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ssid ? { action, ssid } : { action }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null) as { reason?: string } | null;
        setFailed(j?.reason ?? `Could not send it (HTTP ${res.status})`);
      }
    } catch {
      setFailed('Could not reach the server');
    } finally {
      setSending(false);
      router.refresh();
    }
  }

  const heading = (
    <div className="flex items-center gap-1">
      <span className="text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>Wi-Fi networks</span>
      <HelpTip topic="wifi-networks" />
    </div>
  );

  if (s.kind !== 'ready') {
    return (
      <div className="flex flex-col gap-2" data-testid={`wifi-${id}`} data-state={s.kind}>
        {heading}
        <span className="text-[13px]" style={{ color: 'var(--muted)' }} data-testid={`wifi-unsupported-${id}`}>
          {s.kind === 'unknown'
            ? 'Shown once the board reports its firmware.'
            : 'This board’s firmware does not report its Wi-Fi networks. Update the firmware to see and change them here.'}
        </span>
      </div>
    );
  }

  const disabled = busy || sending || s.pending !== null;
  const btn = 'flex min-h-[38px] items-center gap-1.5 whitespace-nowrap rounded-[10px] border px-3.5 text-[13px] font-medium disabled:opacity-50 max-sm:min-h-11';
  const btnStyle = { background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' };
  const until = s.setupUntil ? clock(s.setupUntil) : null;

  return (
    <div className="flex flex-col gap-2" data-testid={`wifi-${id}`} data-state="ready">
      {heading}
      <div className="flex flex-col rounded-[12px] px-3.5 py-1.5" style={{ background: 'var(--surface-2)' }}>
        <ul className="flex flex-col" data-testid={`wifi-nets-${id}`}>
          {s.nets.map((n) => (
            <li key={n.hex} className="flex min-h-[40px] items-center gap-3 border-b last:border-b-0"
                style={{ borderColor: 'var(--line)' }} data-testid={`wifi-net-${id}-${n.hex}`}
                data-current={n.current}>
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full"
                    style={{ background: n.current ? 'var(--online-dot)' : 'var(--line)' }} />
              <span className="min-w-0 flex-1 text-[13px] font-medium" style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>
                {n.name}
              </span>
              <span className="text-[12px]" style={{ color: 'var(--muted)' }} data-testid={`wifi-net-state-${id}-${n.hex}`}>
                {n.current ? 'Connected now' : 'Saved'}
              </span>
              {n.removable && (
                <button type="button" disabled={disabled || s.removeBlocked !== null}
                        aria-label={`Remove ${n.name}`} data-testid={`wifi-remove-${id}-${n.hex}`}
                        onClick={() => void send('remove', n.hex)}
                        className="min-h-[30px] whitespace-nowrap rounded-[8px] border px-2.5 text-[12px] font-medium disabled:opacity-50 max-sm:min-h-11"
                        style={btnStyle}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`wifi-hint-${id}`}>
        The board tries these in this order when it starts. Names only: passwords stay on the board.
        {s.nets.length === 1 ? ' The only network stays; add another before removing it.' : ''}
      </span>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[13px]" style={{ color: 'var(--ink)' }} data-testid={`wifi-setup-${id}`}
              data-open={s.setupUntil !== null}>
          Setup page: {until ? `open until ${until}` : 'closed'}
        </span>
        {s.setupUntil ? (
          <button type="button" className={btn} style={btnStyle} disabled={disabled}
                  data-testid={`wifi-close-${id}`} onClick={() => void send('close')}>
            Close setup page
          </button>
        ) : (
          <button type="button" className={btn} style={btnStyle} disabled={disabled || s.addBlocked !== null}
                  data-testid={`wifi-add-${id}`} onClick={() => void send('open')}>
            Add a network
          </button>
        )}
      </div>
      {!s.setupUntil && s.addBlocked && s.pending === null && (
        <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`wifi-add-blocked-${id}`}>
          {s.addBlocked}
        </span>
      )}
      {s.setupUntil === null && s.addBlocked === null && s.pending === null && (
        <span className="text-[12px]" style={{ color: 'var(--muted-2)' }} data-testid={`wifi-add-hint-${id}`}>
          {s.full ? `${FULL} ` : ''}Add a network opens the board&apos;s setup page for 10 minutes. The board stays online meanwhile.
        </span>
      )}

      {s.pending !== null && (
        <div className="flex flex-wrap items-center gap-3 text-[13px]" style={{ color: 'var(--muted)' }}
             data-testid={`wifi-pending-${id}`} data-op={s.pending}>
          <span>Waiting for the board{online ? '…' : ' (it is offline)'}</span>
          <button type="button" className="underline disabled:opacity-50" disabled={busy || sending}
                  data-testid={`wifi-cancel-${id}`} onClick={() => void send('cancel')}>
            Cancel
          </button>
        </div>
      )}

      {s.setupUntil && until && (
        <ol className="flex list-decimal flex-col gap-1.5 rounded-[12px] py-3 pl-8 pr-3.5 text-[13px]"
            style={{ background: 'var(--surface-2)', color: 'var(--ink)' }} data-testid={`wifi-steps-${id}`}>
          {setupSteps(s.setupNetwork, s.current, until).map((step) => <li key={step}>{step}</li>)}
        </ol>
      )}

      {s.outcome && (
        <span role={s.outcome.ok ? 'status' : 'alert'} className="text-[13px]"
              style={{ color: s.outcome.ok ? 'var(--muted)' : 'var(--amber-text)', overflowWrap: 'anywhere' }}
              data-testid={`wifi-outcome-${id}`} data-ok={s.outcome.ok}>
          {s.outcome.text}
        </span>
      )}
      {failed && (
        <span role="alert" className="text-[13px]" style={{ color: 'var(--amber-text)', overflowWrap: 'anywhere' }}
              data-testid={`wifi-error-${id}`}>{failed}</span>
      )}
    </div>
  );
}
