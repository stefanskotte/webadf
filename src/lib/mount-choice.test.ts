import { describe, expect, it } from 'vitest';
import { holderText, mountChoice, mountChoices, type MountTargetRow } from './mount-choice';
import { STALE_AFTER_MS } from './device-state';

const NOW = 1_700_000_000_000;
const FRESH = new Date(NOW - 1_000);
const OLD = new Date(NOW - STALE_AFTER_MS - 1_000);

const THIS_DISK = 'disk-this';
const THIS_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

function row(over: Partial<MountTargetRow> = {}): MountTargetRow {
  return {
    id: 'dev-1', name: 'Bench',
    desiredSha256: null, mountedSha256: null,
    desiredDiskId: null, mountedDiskId: null,
    desiredGame: null, desiredDiskNo: null,
    mountedGame: null, mountedDiskNo: null,
    lastSeenAt: FRESH,
    ...over,
  };
}

const choose = (r: MountTargetRow) => mountChoice(r, THIS_DISK, THIS_SHA, NOW);

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
      THIS_DISK, THIS_SHA, NOW,
    );
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out.map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('can offer eject on one device and mount on another at the same time', () => {
    const out = mountChoices([
      row({ id: 'a', name: 'A', desiredSha256: THIS_SHA, mountedSha256: THIS_SHA,
            desiredDiskId: THIS_DISK, mountedDiskId: THIS_DISK }),
      row({ id: 'b', name: 'B' }),
    ], THIS_DISK, THIS_SHA, NOW);
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
    expect(holderText(mountChoices([row(), row({ id: 'b' })], THIS_DISK, THIS_SHA, NOW)))
      .toBeNull();
  });

  it('names the device holding it', () => {
    const line = holderText(mountChoices([held({ name: 'Bench' })], THIS_DISK, THIS_SHA, NOW));
    expect(line).toEqual({ text: 'In Bench', stale: false });
  });

  it('names EVERY holder, not just the first', () => {
    // The old sha-keyed map kept one and dropped the rest silently.
    const line = holderText(mountChoices(
      [held({ id: 'a', name: 'A' }), held({ id: 'b', name: 'B' })],
      THIS_DISK, THIS_SHA, NOW));
    expect(line?.text).toBe('In A and B');
  });

  it('lists three with a comma and an "and"', () => {
    const line = holderText(mountChoices(
      [held({ id: 'a', name: 'A' }), held({ id: 'b', name: 'B' }), held({ id: 'c', name: 'C' })],
      THIS_DISK, THIS_SHA, NOW));
    expect(line?.text).toBe('In A, B and C');
  });

  it('reads as unconfirmed, and never as fact, when the device went quiet', () => {
    const line = holderText(mountChoices(
      [row({ name: 'Gone', desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK, lastSeenAt: OLD })],
      THIS_DISK, THIS_SHA, NOW));
    expect(line?.text).toContain('not confirmed');
    expect(line?.text.startsWith('In ')).toBe(false);
    expect(line?.stale).toBe(true);
  });

  it('says a fetch is under way while it is under way', () => {
    const line = holderText(mountChoices(
      [row({ name: 'Bench', desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK, lastSeenAt: FRESH })],
      THIS_DISK, THIS_SHA, NOW));
    expect(line?.text).toBe('Mounting to Bench…');
    expect(line?.stale).toBe(false);
  });

  it('prefers the drive that actually has it over one that merely asked', () => {
    // A confirmed holder is a fact; an unconfirmed request is not. Reporting
    // the request here would state the weaker claim and drop the stronger one.
    const line = holderText(mountChoices([
      held({ id: 'a', name: 'Has It' }),
      row({ id: 'b', name: 'Asked', desiredSha256: THIS_SHA, desiredDiskId: THIS_DISK, lastSeenAt: OLD }),
    ], THIS_DISK, THIS_SHA, NOW));
    expect(line).toEqual({ text: 'In Has It', stale: false });
  });
});
