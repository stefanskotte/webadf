import { describe, expect, it } from 'vitest';
import {
  deliverWifi, setupNetworkFor, setupSteps, wifiHex, wifiName, wifiOutcome, wifiSection, WIFI_HEX_RE, WIFI_OPEN_TTL_MS,
  DISK_IN_DRIVE, BOARD_OFFLINE, FULL, type WifiDevice,
} from './wifi-networks';

const NOW = 1_800_000_000_000;
const HOME = wifiHex('Home');
const PHONE = wifiHex('Phone');   // 50686f6e65

describe('names', () => {
  it('reads the board\'s hex as UTF-8 and writes it back', () => {
    expect(HOME).toBe('486f6d65');
    expect(wifiName('436166c3a9')).toBe('Café');
    expect(wifiHex('Café')).toBe('436166c3a9');
    expect(wifiName('ff41')).toBe('�A');     // not UTF-8: shown, not dropped
    expect(wifiName('4101')).toBe('A�');     // a control octet
  });
  it('accepts 1-32 octets of lowercase hex, no NUL', () => {
    expect(WIFI_HEX_RE.test('41')).toBe(true);
    expect(WIFI_HEX_RE.test('41'.repeat(32))).toBe(true);
    expect(WIFI_HEX_RE.test('41'.repeat(33))).toBe(false);
    expect(WIFI_HEX_RE.test('')).toBe(false);
    expect(WIFI_HEX_RE.test('4')).toBe(false);
    expect(WIFI_HEX_RE.test('4A')).toBe(false);
    expect(WIFI_HEX_RE.test('4100')).toBe(false);
  });
  it('names the setup network as the firmware does: the last two MAC octets', () => {
    expect(setupNetworkFor('28:cd:c1:0a:ee:7f')).toBe('wifi-floppy-EE7F');
    expect(setupNetworkFor(null)).toBeNull();
    expect(setupNetworkFor('nonsense')).toBeNull();
  });
});

describe('deliverWifi (GET /api/device/wifi)', () => {
  const row = { wifiSeq: 4, wifiOp: 'open', wifiOpSsid: null, wifiOpAt: new Date(NOW - 1000), wifiAck: 3 };
  it('sends the op for a seq the board has not reported', () => {
    expect(deliverWifi(row, NOW)).toEqual({ seq: 4, op: 'open' });
    expect(deliverWifi({ ...row, wifiOp: 'close' }, NOW)).toEqual({ seq: 4, op: 'close' });
    expect(deliverWifi({ ...row, wifiOp: 'remove', wifiOpSsid: HOME }, NOW)).toEqual({ seq: 4, op: 'remove', ssid: HOME });
  });
  it('sends none for a seq the board already reported, so a board that restarted does not do it twice', () => {
    expect(deliverWifi({ ...row, wifiAck: 4, wifiOp: 'remove', wifiOpSsid: HOME }, NOW)).toEqual({ seq: 4, op: 'none' });
  });
  it('lets an open lapse after two minutes: nobody is waiting for that setup network any more', () => {
    expect(deliverWifi({ ...row, wifiOpAt: new Date(NOW - WIFI_OPEN_TTL_MS - 1) }, NOW)).toEqual({ seq: 4, op: 'none' });
    expect(deliverWifi({ ...row, wifiOpAt: new Date(NOW - WIFI_OPEN_TTL_MS) }, NOW)).toEqual({ seq: 4, op: 'open' });
    // M4: a remove lapses too -- the network may have been added again on the board's own page meanwhile.
    expect(deliverWifi({ ...row, wifiOp: 'remove', wifiOpSsid: HOME, wifiOpAt: new Date(0) }, NOW).op).toBe('none');
    expect(deliverWifi({ ...row, wifiOp: 'remove', wifiOpSsid: HOME, wifiOpAt: new Date(NOW - 1000) }, NOW).op).toBe('remove');
    // A close never lapses: closing late is still what was asked.
    expect(deliverWifi({ ...row, wifiOp: 'close', wifiOpAt: new Date(0) }, NOW).op).toBe('close');
  });
  it('fits the board\'s 128-byte buffer at its longest', () => {
    const longest = JSON.stringify(deliverWifi({ ...row, wifiSeq: 2_147_483_647, wifiOp: 'remove', wifiOpSsid: 'ff'.repeat(32) }, NOW));
    expect(Buffer.byteLength(longest) + 1).toBeLessThanOrEqual(128);
  });
  it('never sends an unknown op or a bad name', () => {
    expect(deliverWifi({ ...row, wifiOp: 'rename' }, NOW).op).toBe('none');
    expect(deliverWifi({ ...row, wifiOp: 'remove', wifiOpSsid: 'zz' }, NOW).op).toBe('none');
  });
});

const ready: WifiDevice = {
  firmwareVersion: '1.26.0', macAddress: '28:cd:c1:0a:ee:7f', mountedSha256: null,
  wifiNets: [HOME, PHONE], wifiCurrent: 0, wifiSetupUntil: null,
  wifiSeq: 0, wifiOp: 'none', wifiOpSsid: null, wifiAck: null, wifiResult: null,
};

describe('wifiSection', () => {
  it('says why there is nothing to show: no firmware reported yet, or a firmware that does not report networks', () => {
    expect(wifiSection({ ...ready, wifiNets: null, firmwareVersion: null }, true, NOW)).toEqual({ kind: 'unknown' });
    expect(wifiSection({ ...ready, wifiNets: null }, true, NOW)).toEqual({ kind: 'old_firmware' });
  });
  it('lists every network with both states, and which can go', () => {
    const s = wifiSection(ready, true, NOW);
    if (s.kind !== 'ready') throw new Error(s.kind);
    expect(s.nets).toEqual([
      { hex: HOME, name: 'Home', current: true, removable: false },
      { hex: PHONE, name: 'Phone', current: false, removable: true },
    ]);
    expect(s.current).toBe('Home');
    expect(s.setupNetwork).toBe('wifi-floppy-EE7F');
    expect(s.addBlocked).toBeNull();
    expect(s.pending).toBeNull();
    const one = wifiSection({ ...ready, wifiNets: [HOME], wifiCurrent: null }, true, NOW);
    if (one.kind !== 'ready') throw new Error(one.kind);
    expect(one.nets[0].removable).toBe(false);   // the last one stays
  });
  it('blocks Add when it could not work, and says why', () => {
    const s = (d: Partial<WifiDevice>, online = true) => {
      const r = wifiSection({ ...ready, ...d }, online, NOW);
      if (r.kind !== 'ready') throw new Error(r.kind);
      return r;
    };
    expect(s({}, false).addBlocked).toBe(BOARD_OFFLINE);
    expect(s({ mountedSha256: 'a'.repeat(64) }).addBlocked).toBe(DISK_IN_DRIVE);
    expect(s({ mountedSha256: 'a'.repeat(64) }).removeBlocked).toBe(DISK_IN_DRIVE);
    // M5: four saved does not block Add -- the page changes a saved network's password -- it says so.
    const full = s({ wifiNets: [HOME, PHONE, wifiHex('c'), wifiHex('d')] });
    expect(full.addBlocked).toBeNull();
    expect(full.full).toBe(true);
    expect(FULL).toMatch(/you can change a password, or remove one/);
  });
  it('shows the setup page open only while it is, and only while the board is online', () => {
    const until = new Date(NOW + 300_000);
    const s = (d: Partial<WifiDevice>, online = true) => {
      const r = wifiSection({ ...ready, ...d }, online, NOW);
      if (r.kind !== 'ready') throw new Error(r.kind);
      return r;
    };
    expect(s({ wifiSetupUntil: until }).setupUntil).toEqual(until);
    expect(s({ wifiSetupUntil: new Date(NOW - 1) }).setupUntil).toBeNull();
    expect(s({ wifiSetupUntil: until }, false).setupUntil).toBeNull();
  });
  it('is waiting while the board has not acked the seq, and then says what it did', () => {
    const s = (d: Partial<WifiDevice>) => {
      const r = wifiSection({ ...ready, ...d }, true, NOW);
      if (r.kind !== 'ready') throw new Error(r.kind);
      return r;
    };
    expect(s({ wifiSeq: 2, wifiOp: 'remove', wifiOpSsid: PHONE, wifiAck: 1 }).pending).toBe('remove');
    expect(s({ wifiSeq: 2, wifiOp: 'open', wifiAck: null }).pending).toBe('open');
    expect(s({ wifiSeq: 2, wifiOp: 'remove', wifiOpSsid: PHONE, wifiAck: 2, wifiResult: 'ok' }).outcome)
      .toEqual({ ok: true, text: 'Removed “Phone”.' });
    expect(s({ wifiSeq: 2, wifiOp: 'remove', wifiOpSsid: PHONE, wifiAck: 2, wifiResult: 'disk' }).outcome?.ok).toBe(false);
    expect(s({ wifiSeq: 3, wifiOp: 'open', wifiAck: 3, wifiResult: 'ok' }).outcome).toBeNull();
    expect(s({ wifiSeq: 3, wifiOp: 'open', wifiAck: 3, wifiResult: 'none' }).outcome?.text).toMatch(/did not open its setup page in time/);
  });
});

describe('the words', () => {
  it('names the network and the reason for each refusal', () => {
    expect(wifiOutcome('remove', 'Home', 'in_use')?.text).toBe('Could not remove “Home”: the board is on it now.');
    expect(wifiOutcome('remove', 'Home', 'only_one')?.text).toMatch(/only saved network/);
    expect(wifiOutcome('remove', 'Home', 'not_saved')).toEqual({ ok: true, text: '“Home” was already gone from the board.' });
    expect(wifiOutcome('open', null, 'disk')?.text).toContain(DISK_IN_DRIVE);
    expect(wifiOutcome('open', null, 'subnet')?.text).toMatch(/192\.168\.4\.x/);
    expect(wifiOutcome('none', null, 'none')).toEqual({ ok: true, text: 'Cancelled.' });
    // M1: the board opened its page before the cancel reached it -- not "Cancelled", and Close is offered.
    expect(wifiOutcome('none', null, 'none', true)?.text).toMatch(/already opened its setup page\. Press Close setup page/);
    expect(wifiOutcome('remove', 'Home', 'none')?.text).toMatch(/was not removed: the board was offline/);
    expect(wifiOutcome('remove', 'Home', null)).toBeNull();
  });
  it('gives the steps with the setup network, its password and address, where the board goes back, and the time', () => {
    const steps = setupSteps('wifi-floppy-EE7F', 'Home', '14:32');
    expect(steps).toHaveLength(4);
    expect(steps[0]).toBe('On your phone or computer, join the Wi-Fi network wifi-floppy-EE7F (password wififloppy).');
    expect(steps[1]).toContain('http://192.168.4.1');
    expect(steps[2]).toContain('goes back to “Home”');
    expect(steps[3]).toBe('The setup page closes at 14:32, or when you press Done on it or Close setup page here.');
  });
});
