import { describe, it, expect } from 'vitest';
import {
  adfSendName, canCancel, canRetry, cardSendLine, clearableCount, orderQueue, failureText, formatSize, longOffline, offlineFor, orderTargets,
  pickTarget, receiverLine, receiverRunning, sendErrorText, targetState, transferState,
  type SendTarget, type TransferView,
} from './send-ui';

const NOW = 1_800_000_000_000;
const t = (over: Partial<SendTarget> = {}): SendTarget => ({
  id: 'a', name: 'Bench', macAddress: '28:CD:C1:19:6A:38', defaultName: false, online: true,
  lastSeenAt: NOW - 5_000, network: true, rx: 'c', rxAt: NOW - 10_000, ...over,
});
const row = (over: Partial<TransferView> = {}): TransferView => ({
  id: 'x', path: 'Café.lha', sizeBytes: 1000, status: 'queued', bytesSent: 0, savedAs: null, errorCode: null,
  errorText: null, createdAt: NOW, finishedAt: null, ...over,
});

describe('transfer states, each in words', () => {
  it('names every status', () => {
    expect(transferState(row()).text).toBe('Waiting');
    expect(transferState(row({ status: 'sending', bytesSent: 500 })).text).toBe('Sending 50 %');
    expect(transferState(row({ status: 'sending', bytesSent: 1000 })).text).toBe('Sending 99 %');
    expect(transferState(row({ status: 'delivered', savedAs: 'Café_2.lha' })).text).toBe('Delivered · saved as Café_2.lha');
    expect(transferState(row({ status: 'failed', errorCode: 'space', errorText: 'disk full' })).text)
      .toBe('Failed · not enough space on the Amiga');
    expect(transferState(row({ status: 'cancelled' })).text).toBe('Cancelled');
    expect(transferState(row({ status: 'expired' })).text).toBe('Expired · the Amiga did not take it within 24 h');
  });
  it('falls back to Receive\'s own text for a code it does not know', () => {
    expect(failureText('odd', 'something broke')).toBe('something broke');
    expect(failureText(null, null)).toBe('unknown reason');
  });
  it('offers Cancel while waiting or moving, Retry once it failed or expired', () => {
    expect(['queued', 'sending'].every((s) => canCancel(s as never))).toBe(true);
    expect(['delivered', 'failed', 'cancelled', 'expired'].some((s) => canCancel(s as never))).toBe(false);
    expect(canRetry('failed') && canRetry('expired')).toBe(true);
    expect(canRetry('cancelled') || canRetry('delivered')).toBe(false);
  });
});

describe('the receiver line', () => {
  it('says running only for a fresh connected reading, or while a file moves (R6)', () => {
    expect(receiverRunning(t(), false, NOW)).toBe(true);
    expect(receiverRunning(t({ rxAt: NOW - 80_000 }), false, NOW)).toBe(false);
    expect(receiverRunning(t({ rxAt: NOW - 80_000 }), true, NOW)).toBe(true);
    expect(receiverRunning(t({ rx: 'r' }), true, NOW)).toBe(false);
  });
  it('names the reason in words, most basic first', () => {
    const q = { waiting: 0, sending: false };
    expect(receiverLine(t({ online: false }), q, NOW)).toEqual({ ok: false, text: 'The board is offline. Files wait until it is back.' });
    expect(receiverLine(t({ network: false }), q, NOW).text).toBe('The board is not in Network mode. Files wait until it is.');
    expect(receiverLine(t(), q, NOW)).toEqual({ ok: true, text: 'Receive is running on the Amiga' });
    expect(receiverLine(t({ rx: '-' }), q, NOW).text).toBe('The board has not seen the Amiga on the network yet');
    expect(receiverLine(t({ rx: null }), q, NOW).text).toBe('The board has not seen the Amiga on the network yet');
    expect(receiverLine(t({ rx: 'r' }), { waiting: 2, sending: false }, NOW).text).toBe('Start Receive on the Amiga');
    expect(receiverLine(t({ rx: 'r' }), q, NOW).text).toBe('Receive is not running on the Amiga');
    expect(receiverLine(t({ rx: 'u' }), q, NOW).text).toBe('The Amiga does not answer');
  });
});

describe('boards to send to', () => {
  it('says online, or how long offline', () => {
    expect(targetState(t(), NOW)).toBe('online');
    expect(targetState(t({ online: false, lastSeenAt: NOW - 7 * 3600_000 }), NOW)).toBe('offline 7 h');
    expect(targetState(t({ online: false, lastSeenAt: null }), NOW)).toBe('never seen');
    expect(offlineFor(30 * 60_000)).toBe('30 min');
    expect(offlineFor(5 * 86_400_000)).toBe('5 days');
  });
  it('puts online boards first, then by name; long offline is over 24 h (R7)', () => {
    const ts = [t({ id: 'z', name: 'Zed', online: false }), t({ id: 'b', name: 'Beta' }), t({ id: 'a', name: 'Alpha' })];
    expect(orderTargets(ts).map((x) => x.id)).toEqual(['a', 'b', 'z']);
    expect(longOffline(t({ online: false, lastSeenAt: NOW - 25 * 3600_000 }), NOW)).toBe(true);
    expect(longOffline(t({ online: false, lastSeenAt: NOW - 3600_000 }), NOW)).toBe(false);
  });
  it('keeps a wanted board only while it is still a target (Review Focus 1)', () => {
    const ts = [t({ id: 'old', name: 'Old', online: false, lastSeenAt: NOW - 30 * 86_400_000 }), t({ id: 'new', name: 'New' })];
    expect(pickTarget(ts, 'old', NOW)).toBe('old');
    expect(pickTarget(ts, 'deleted-board', NOW)).toBe('new');
    expect(pickTarget(ts, null, NOW)).toBe('new');
    expect(pickTarget([], 'new', NOW)).toBeNull();
    expect(pickTarget([ts[0]], null, NOW)).toBe('old');
  });
});

describe('the card line and names', () => {
  it('counts what waits and what happened, and always says whether Receive runs', () => {
    expect(cardSendLine(undefined, true)).toBeNull();
    expect(cardSendLine({ waiting: 0, sending: 0, delivered: 0, failed: 0 }, true)).toBeNull();
    expect(cardSendLine({ waiting: 3, sending: 0, delivered: 1, failed: 0 }, true)).toBe('3 files waiting · Receive running');
    expect(cardSendLine({ waiting: 1, sending: 1, delivered: 0, failed: 1 }, false))
      .toBe('1 file waiting · 1 sending · 1 failed · Receive not running');
    expect(cardSendLine({ waiting: 0, sending: 0, delivered: 2, failed: 0 }, false)).toBe('2 delivered · Receive not running');
  });
  it('names a whole disk <name>.adf, whatever it was uploaded as', () => {
    expect(adfSendName({ tosecName: 'Lotus (1990)(Gremlin).adf', sourceFilename: 'x.dms', diskNo: 1 })).toBe('Lotus (1990)(Gremlin).adf');
    expect(adfSendName({ tosecName: null, sourceFilename: 'Turrican.DMS', diskNo: 2 })).toBe('Turrican.adf');
    expect(adfSendName({ tosecName: null, sourceFilename: null, diskNo: 3 })).toBe('Disk 3.adf');
  });
  it('turns every refusal into a sentence', () => {
    expect(sendErrorText('too_large', 413)).toBe('Over 4 MB: too large to send.');
    expect(sendErrorText('queue_full', 409)).toMatch(/32 files or 16 MB/);
    expect(sendErrorText('not_finished', 409)).toBe('It is still waiting or on its way.');
    expect(sendErrorText('not_found', 404)).toBe('That file or disk is no longer there.');
    expect(sendErrorText('blob_unavailable', 503)).toBe('The disk could not be read just now. Try again.');
    expect(sendErrorText(undefined, 502)).toBe('The server answered 502.');
  });
  it('sizes read as B, KB, MB', () => {
    expect(formatSize(44)).toBe('44 B');
    expect(formatSize(901_120)).toBe('880 KB');
    expect(formatSize(4_194_304)).toBe('4.0 MB');
  });
});

describe('the queue list', () => {
  it('orderQueue puts waiting and sending rows first and keeps the order inside each group', () => {
    const rows = [row({ id: 'd1', status: 'delivered' }), row({ id: 'q1' }), row({ id: 'f1', status: 'failed' }),
      row({ id: 's1', status: 'sending' }), row({ id: 'e1', status: 'expired' }), row({ id: 'q2' })];
    expect(orderQueue(rows).map((r) => r.id)).toEqual(['q1', 's1', 'q2', 'd1', 'f1', 'e1']);
  });
  it('clearableCount counts what Clear finished removes: every row that is not waiting or sending', () => {
    const rows = (['queued', 'sending', 'delivered', 'failed', 'cancelled', 'expired'] as const).map((status, i) => row({ id: `r${i}`, status }));
    expect(clearableCount(rows)).toBe(4);
    expect(clearableCount([row(), row({ status: 'sending' })])).toBe(0);
  });
});
