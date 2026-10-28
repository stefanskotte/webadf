import { describe, it, expect } from 'vitest';
import { shareStatusText, shareScopeText, revokeConfirmText, canDeleteShare, toShareView, type ShareView } from './view';

const base: ShareView = {
  id: 's1', label: 'Rob', everything: false, collectionIds: ['c2', 'c1'], status: 'waiting',
  claimExpiresAt: '2026-11-04T10:00:00.000Z', claimedAt: null, claimedByUrl: null, claimedByName: null,
  lastUsedAt: null, createdAt: '2026-10-28T10:00:00.000Z',
};
const names = new Map([['c1', 'Demos'], ['c2', 'Games']]);

describe('shareStatusText', () => {
  it('waiting names the expiry date', () => {
    expect(shareStatusText(base)).toMatch(/^Waiting to be claimed, until /);
    expect(shareStatusText(base)).toMatch(/2026/);
  });
  it('expired, revoked', () => {
    expect(shareStatusText({ ...base, status: 'expired' })).toBe('Expired');
    expect(shareStatusText({ ...base, status: 'revoked' })).toBe('Revoked');
  });
  it('claimed names who and where', () => {
    expect(shareStatusText({ ...base, status: 'claimed', claimedByName: 'Rob WF', claimedByUrl: 'https://rob.example' }))
      .toBe('Claimed by Rob WF (https://rob.example)');
  });
});

describe('shareScopeText', () => {
  it('Everything', () => expect(shareScopeText({ ...base, everything: true }, names)).toBe('Everything'));
  it('names sorted, unknown ids skipped', () => {
    expect(shareScopeText({ ...base, collectionIds: ['c2', 'gone', 'c1'] }, names)).toBe('Demos, Games');
  });
  it('no collection left', () => expect(shareScopeText({ ...base, collectionIds: ['gone'] }, names)).toBe('No collections'));
});

describe('revokeConfirmText', () => {
  it('is the spec sentence with the label', () => {
    expect(revokeConfirmText('Rob')).toBe('Rob loses access immediately. Disks Rob has changed stay theirs.');
  });
});

describe('canDeleteShare', () => {
  it('only revoked and expired', () => {
    expect(canDeleteShare('revoked')).toBe(true);
    expect(canDeleteShare('expired')).toBe(true);
    expect(canDeleteShare('waiting')).toBe(false);
    expect(canDeleteShare('claimed')).toBe(false);
  });
});

describe('toShareView', () => {
  it('turns dates into ISO strings', () => {
    const v = toShareView({
      ...base, claimExpiresAt: new Date('2026-11-04T10:00:00Z'), claimedAt: null,
      lastUsedAt: new Date('2026-10-29T00:00:00Z'), createdAt: new Date('2026-10-28T10:00:00Z'),
    });
    expect(v.claimExpiresAt).toBe('2026-11-04T10:00:00.000Z');
    expect(v.lastUsedAt).toBe('2026-10-29T00:00:00.000Z');
    expect(v.claimedAt).toBeNull();
  });
});

describe('reachCheckOnLoad (final review 10)', () => {
  it('Settings asks the server to ping itself on load only when something is shared', async () => {
    const { reachCheckOnLoad } = await import('./view');
    expect(reachCheckOnLoad(0)).toBe(false);
    expect(reachCheckOnLoad(1)).toBe(true);
    expect(reachCheckOnLoad(5)).toBe(true);
  });
});
