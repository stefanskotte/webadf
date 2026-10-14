import { describe, expect, it } from 'vitest';
import { holderText, mountChoice, mountChoices, type MountTargetRow, type MountDisk } from './mount-choice';
import { STALE_AFTER_MS } from './device-state';

const NOW = 1_700_000_000_000;
const FRESH = new Date(NOW - 1_000);
const OLD = new Date(NOW - STALE_AFTER_MS - 1_000);

const THIS_DISK = 'disk-this';
const THIS_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const DISK: MountDisk = { id: THIS_DISK, sha256: THIS_SHA, imageFormat: 'adf', sizeBytes: 901_120 };

function row(over: Partial<MountTargetRow> = {}): MountTargetRow {
  return {
    id: 'dev-1', name: 'Bench',
    desiredSha256: null, mountedSha256: null,
    desiredDiskId: null, mountedDiskId: null,
    desiredGame: null, desiredDiskNo: null,
    mountedGame: null, mountedDiskNo: null,
    lastSeenAt: FRESH,
    secondDrive: 'off', secondDriveReported: null, secondDriveVersion: 0, secondDriveAppliedVersion: null,
    firmwareVersion: null, df1DiskId: null, df1Sha256: null, df1PickSha256: null,
    ...over,
  };
}

const choose = (r: MountTargetRow) => mountChoice(r, DISK, NOW);

describe('an idle device', () => {
  it('offers a mount and says it is holding nothing', () => {
    const c = choose(row());
    expect(c.state).toBe('empty');
    expect(c.holding).toBeNull();
    expect(c.isThisDisk).toBe(false);
    expect(c.action).toBe('mount');
    expect(c.actionLabel).toBe('Mount here');
  });
});

describe('a device holding this very disk', () => {
  const holding = row({
    desiredSha256: THIS_SHA, mountedSha256: THIS_SHA,
    desiredDiskId: THIS_DISK, mountedDiskId: THIS_DISK,
    mountedGame: 'Lemmings', mountedDiskNo: 2,
  });

  it('offers eject, not another mount', () => {
    const c = choose(holding);
    expect(c.isThisDisk).toBe(true);
    expect(c.action).toBe('eject');
    expect(c.actionLabel).toBe('Eject');
  });

  it('names what it is holding', () => {
    expect(choose(holding).holding).toBe('Lemmings — disk 2');
  });
});

describe('a device holding a DIFFERENT disk', () => {
  it('offers a mount, and says what it would displace', () => {
    const c = choose(row({
      desiredSha256: OTHER_SHA, mountedSha256: OTHER_SHA,
      desiredDiskId: 'disk-other', mountedDiskId: 'disk-other',
      mountedGame: 'Turrican', mountedDiskNo: 1,
    }));
    expect(c.isThisDisk).toBe(false);
    expect(c.action).toBe('mount');
    expect(c.holding).toBe('Turrican — disk 1');
  });
});

describe('a fetch still in flight', () => {
  // The device has not confirmed anything yet, so the DESIRED side is what the
  // person is waiting on -- not the disk still physically in the drive.
  const fetchingThis = row({
    desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK,
    desiredGame: 'Lemmings', desiredDiskNo: 2,
    mountedSha256: OTHER_SHA, mountedDiskId: 'disk-other',
    mountedGame: 'Turrican', mountedDiskNo: 1,
    lastSeenAt: FRESH,
  });

  it('is pending, and counts as this disk even though the drive still holds another', () => {
    const c = choose(fetchingThis);
    expect(c.state).toBe('pending');
    expect(c.isThisDisk).toBe(true);
  });

  it('offers Cancel rather than Eject, because nothing has landed yet', () => {
    expect(choose(fetchingThis).actionLabel).toBe('Cancel');
    expect(choose(fetchingThis).action).toBe('eject');
  });

  it('describes the disk being fetched, not the one still mounted', () => {
    expect(choose(fetchingThis).holding).toBe('fetching Lemmings — disk 2');
  });
});

describe('a device that stopped answering', () => {
  const stale = row({
    desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK,
    desiredGame: 'Lemmings', desiredDiskNo: 2,
    lastSeenAt: OLD,
  });

  it('is stale, and says the request is unconfirmed rather than implying success', () => {
    const c = choose(stale);
    expect(c.state).toBe('stale');
    expect(c.holding).toBe('Lemmings — disk 2 requested — not confirmed');
  });

  it('still counts as holding this disk, so the row offers a way out', () => {
    expect(choose(stale).isThisDisk).toBe(true);
    expect(choose(stale).action).toBe('eject');
  });

  it('never reads as confirmed', () => {
    // The §7 rule: desired state must not be presented as fact. Guard the
    // wording, since that is the whole point of four states rather than two.
    expect(choose(stale).holding).toContain('not confirmed');
    expect(choose(stale).actionLabel).not.toBe('Eject');
  });
});

describe('telling two disk rows with the same content apart', () => {
  // A re-upload of identical bytes under a second title produces two rows with
  // one digest. Matching on the digest alone would light up BOTH rows.
  it('prefers the disk id over the digest', () => {
    const c = choose(row({
      desiredSha256: THIS_SHA, mountedSha256: THIS_SHA,
      desiredDiskId: 'disk-twin', mountedDiskId: 'disk-twin',
      mountedGame: 'Lemmings', mountedDiskNo: 2,
    }));
    expect(c.isThisDisk).toBe(false);
    expect(c.action).toBe('mount');
  });

  it('falls back to the digest when no id was resolved', () => {
    // recordStatus could not resolve the reported digest to a row, so the
    // digest is the only evidence there is. Reporting an empty drive that
    // visibly holds something would be worse.
    const c = choose(row({
      desiredSha256: THIS_SHA, mountedSha256: THIS_SHA,
      desiredDiskId: null, mountedDiskId: null,
    }));
    expect(c.isThisDisk).toBe(true);
    expect(c.action).toBe('eject');
  });
});

describe('a disk whose title did not resolve', () => {
  it('degrades to "a disk" rather than rendering a null', () => {
    const c = choose(row({
      desiredSha256: OTHER_SHA, mountedSha256: OTHER_SHA,
      desiredDiskId: 'disk-other', mountedDiskId: 'disk-other',
    }));
    expect(c.holding).toBe('a disk');
    expect(c.holding).not.toContain('null');
  });
});

describe('mountChoices', () => {
  it('maps every device and keeps their order', () => {
    const out = mountChoices(
      [row({ id: 'a', name: 'A' }), row({ id: 'b', name: 'B' })],
      DISK, NOW,
    );
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out.map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('can offer eject on one device and mount on another at the same time', () => {
    const out = mountChoices([
      row({ id: 'a', name: 'A', desiredSha256: THIS_SHA, mountedSha256: THIS_SHA,
            desiredDiskId: THIS_DISK, mountedDiskId: THIS_DISK }),
      row({ id: 'b', name: 'B' }),
    ], DISK, NOW);
    expect(out.map((c) => c.action)).toEqual(['eject', 'mount']);
  });
});

describe('holderText', () => {
  const held = (over: Partial<MountTargetRow> = {}) => row({
    desiredSha256: THIS_SHA, mountedSha256: THIS_SHA,
    desiredDiskId: THIS_DISK, mountedDiskId: THIS_DISK,
    ...over,
  });

  it('says nothing when no device has this disk', () => {
    expect(holderText(mountChoices([row(), row({ id: 'b' })], DISK, NOW)))
      .toBeNull();
  });

  it('names the device holding it', () => {
    const line = holderText(mountChoices([held({ name: 'Bench' })], DISK, NOW));
    expect(line).toEqual({ text: 'In Bench', stale: false });
  });

  it('names EVERY holder, not just the first', () => {
    // The old sha-keyed map kept one and dropped the rest silently.
    const line = holderText(mountChoices(
      [held({ id: 'a', name: 'A' }), held({ id: 'b', name: 'B' })],
      DISK, NOW));
    expect(line?.text).toBe('In A and B');
  });

  it('lists three with a comma and an "and"', () => {
    const line = holderText(mountChoices(
      [held({ id: 'a', name: 'A' }), held({ id: 'b', name: 'B' }), held({ id: 'c', name: 'C' })],
      DISK, NOW));
    expect(line?.text).toBe('In A, B and C');
  });

  it('reads as unconfirmed, and never as fact, when the device went quiet', () => {
    const line = holderText(mountChoices(
      [row({ name: 'Gone', desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK, lastSeenAt: OLD })],
      DISK, NOW));
    expect(line?.text).toContain('not confirmed');
    expect(line?.text.startsWith('In ')).toBe(false);
    expect(line?.stale).toBe(true);
  });

  it('says a fetch is under way while it is under way', () => {
    const line = holderText(mountChoices(
      [row({ name: 'Bench', desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK, lastSeenAt: FRESH })],
      DISK, NOW));
    expect(line?.text).toBe('Mounting to Bench…');
    expect(line?.stale).toBe(false);
  });

  it('prefers the drive that actually has it over one that merely asked', () => {
    // A confirmed holder is a fact; an unconfirmed request is not. Reporting
    // the request here would state the weaker claim and drop the stronger one.
    const line = holderText(mountChoices([
      held({ id: 'a', name: 'Has It' }),
      row({ id: 'b', name: 'Asked', desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK, lastSeenAt: OLD }),
    ], DISK, NOW));
    expect(line).toEqual({ text: 'In Has It', stale: false });
  });
});

describe('Cancel on a swap does not empty the drive', () => {
  it('asks for the disk the board still holds when one is confirmed', () => {
    const c = choose(row({
      desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK,
      mountedSha256: OTHER_SHA, mountedDiskId: 'disk-held',
    }));
    expect(c.actionLabel).toBe('Cancel');
    expect(c.revertDiskId).toBe('disk-held');
  });

  it('empties the drive when nothing is confirmed in it', () => {
    const c = choose(row({ desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK }));
    expect(c.actionLabel).toBe('Cancel');
    expect(c.revertDiskId).toBeNull();
  });

  it('a confirmed Eject never reverts', () => {
    const c = choose(row({
      desiredSha256: THIS_SHA, mountedSha256: THIS_SHA, desiredDiskId: THIS_DISK, mountedDiskId: THIS_DISK,
    }));
    expect(c.actionLabel).toBe('Eject');
    expect(c.revertDiskId).toBeNull();
  });
});

describe('DF1 (spec 2026-10-14 §3.3)', () => {
  const on = (over: Partial<MountTargetRow> = {}) => row({
    secondDrive: 'df1', secondDriveReported: 'df1', secondDriveVersion: 1, secondDriveAppliedVersion: 1,
    firmwareVersion: '1.12.0+gabc1234', ...over,
  });

  it('no DF1 choice unless the board runs On (D1: Off and Network mount to DF0 as today)', () => {
    expect(choose(row()).df1).toBeNull();
    expect(choose(row({ secondDrive: 'net' })).df1).toBeNull();
  });

  it('offers DF1 for a standard DD disk on 1.12.0', () => {
    expect(choose(on()).df1).toEqual({ enabled: true, reason: null, isThisDisk: false });
  });

  it('disables it with the reason in words', () => {
    expect(choose(on({ firmwareVersion: '1.11.1+g0a157eb' })).df1?.reason).toBe('Needs firmware 1.12.0');
    expect(mountChoice(on(), { ...DISK, imageFormat: 'hfe' }, NOW).df1?.reason).toBe('DF1 takes standard DD disks only');
    expect(choose(on({ desiredDiskId: THIS_DISK, desiredSha256: THIS_SHA })).df1?.reason).toBe('Already in DF0');
    expect(choose(on({ secondDriveAppliedVersion: 0 })).df1?.reason).toBe('Waiting for the board');
  });

  it('the disk in DF1 is offered for ejecting, and the holder line says DF1 once the board holds it', () => {
    const c = choose(on({ df1DiskId: THIS_DISK, df1PickSha256: THIS_SHA, df1Sha256: THIS_SHA }));
    expect(c.df1).toEqual({ enabled: true, reason: null, isThisDisk: true });
    expect(c.isThisDisk).toBe(false);                    // DF0 does not hold it
    expect(holderText([c])).toEqual({ text: 'In Bench (DF1)', stale: false });
  });

  it('until the board reports the pick\'s digest, the holder line is "Mounting to", never "In"', () => {
    // Not reported yet, and still reporting the previous DF1 disk: both unconfirmed.
    for (const df1Sha256 of [null, OTHER_SHA]) {
      const c = choose(on({ df1DiskId: THIS_DISK, df1PickSha256: THIS_SHA, df1Sha256 }));
      expect(c.df1?.isThisDisk).toBe(true);              // still offered for ejecting
      const line = holderText([c]);
      expect(line).toEqual({ text: 'Mounting to Bench (DF1)…', stale: false });
      expect(line?.text.startsWith('In')).toBe(false);
    }
  });

  it('a confirmed DF1 board outranks one still loading', () => {
    const held = choose(on({ id: 'a', name: 'A', df1DiskId: THIS_DISK, df1PickSha256: THIS_SHA, df1Sha256: THIS_SHA }));
    const loading = choose(on({ id: 'b', name: 'B', df1DiskId: THIS_DISK, df1PickSha256: THIS_SHA }));
    expect(holderText([held, loading])?.text).toBe('In A (DF1)');
  });

  it('DF0 holding the disk outranks DF1 in the holder line', () => {
    const c = choose(on({ desiredDiskId: THIS_DISK, mountedDiskId: THIS_DISK, desiredSha256: THIS_SHA, mountedSha256: THIS_SHA }));
    expect(holderText([c])?.text).toBe('In Bench');
  });
});
