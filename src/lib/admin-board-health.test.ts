import { describe, it, expect } from 'vitest';
import {
  attentionReasons, sortAttention, orderDistribution, versionLabel, needsAttention,
  ATTENTION_LIMIT, ERROR_WINDOW_MS, OFFLINE_AFTER_MS, SEEN_WINDOW_MS,
  type BoardHealthRow,
} from './admin-board-health';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const CURRENT = { version: '1.21.1+gabc1234', sequence: 119 };

function board(over: Partial<BoardHealthRow> = {}): BoardHealthRow {
  return {
    deviceId: 'd1', name: 'Board', ownerEmail: 'o@example.test',
    firmwareVersion: CURRENT.version, sequence: CURRENT.sequence,
    lastSeenAt: new Date(NOW - 10_000), lastError: null, lastErrorAt: null,
    ...over,
  };
}

describe('attentionReasons', () => {
  it('a healthy board on the current release has no reasons', () => {
    expect(attentionReasons(board(), CURRENT, NOW)).toEqual([]);
  });

  it('an error within 24 h reads "Error <relative>: <last_error>"', () => {
    const r = attentionReasons(board({ lastError: 'mount failed', lastErrorAt: new Date(NOW - 2 * H) }), CURRENT, NOW);
    expect(r).toEqual([{ kind: 'error', text: 'Error 2h ago: mount failed' }]);
  });

  it('an error exactly 24 h old still counts; one a second older does not', () => {
    expect(attentionReasons(board({ lastError: 'x', lastErrorAt: new Date(NOW - ERROR_WINDOW_MS) }), CURRENT, NOW))
      .toEqual([{ kind: 'error', text: 'Error 1d ago: x' }]);
    expect(attentionReasons(board({ lastError: 'x', lastErrorAt: new Date(NOW - ERROR_WINDOW_MS - 1000) }), CURRENT, NOW))
      .toEqual([]);
  });

  it('an error timestamp with no text is not an error', () => {
    expect(attentionReasons(board({ lastError: null, lastErrorAt: new Date(NOW - H) }), CURRENT, NOW)).toEqual([]);
  });

  it('an older release seen in 7 days is behind', () => {
    const r = attentionReasons(board({ firmwareVersion: '1.20.2+gdef', sequence: 114 }), CURRENT, NOW);
    expect(r).toEqual([{ kind: 'behind', text: 'Behind: runs 1.20.2+gdef, current is 1.21.1+gabc1234' }]);
  });

  it('a newer sequence than current (a bench build) is not behind', () => {
    expect(attentionReasons(board({ firmwareVersion: '1.22.0+gtest', sequence: 120 }), CURRENT, NOW)).toEqual([]);
  });

  it('an unrecognised version (no release row) is behind', () => {
    const r = attentionReasons(board({ firmwareVersion: '9.9.9+gwho', sequence: null }), CURRENT, NOW);
    expect(r).toEqual([{ kind: 'behind', text: 'Behind: runs 9.9.9+gwho, current is 1.21.1+gabc1234' }]);
  });

  it('a NULL firmware_version is behind and says unknown', () => {
    const r = attentionReasons(board({ firmwareVersion: null, sequence: null }), CURRENT, NOW);
    expect(r).toEqual([{ kind: 'behind', text: 'Behind: runs unknown, current is 1.21.1+gabc1234' }]);
  });

  it('with no current release nothing is behind', () => {
    expect(attentionReasons(board({ firmwareVersion: '0.1.0', sequence: null }), null, NOW)).toEqual([]);
  });

  it('seen between 24 h and 7 days ago reads "Offline <relative>"', () => {
    expect(attentionReasons(board({ lastSeenAt: new Date(NOW - 3 * D) }), CURRENT, NOW))
      .toEqual([{ kind: 'offline', text: 'Offline 3d ago' }]);
  });

  it('offline boundaries: exactly 24 h is not offline; exactly 7 d is; past 7 d is nothing', () => {
    expect(attentionReasons(board({ lastSeenAt: new Date(NOW - OFFLINE_AFTER_MS) }), CURRENT, NOW)).toEqual([]);
    expect(attentionReasons(board({ lastSeenAt: new Date(NOW - OFFLINE_AFTER_MS - 1000) }), CURRENT, NOW))
      .toEqual([{ kind: 'offline', text: 'Offline 1d ago' }]);
    expect(attentionReasons(board({ lastSeenAt: new Date(NOW - SEEN_WINDOW_MS) }), CURRENT, NOW))
      .toEqual([{ kind: 'offline', text: 'Offline 7d ago' }]);
    expect(attentionReasons(board({ lastSeenAt: new Date(NOW - SEEN_WINDOW_MS - 1000) }), CURRENT, NOW)).toEqual([]);
  });

  it('behind needs a sighting in 7 days', () => {
    expect(attentionReasons(board({ firmwareVersion: 'old', sequence: 1, lastSeenAt: new Date(NOW - 8 * D) }), CURRENT, NOW))
      .toEqual([]);
  });

  it('a NULL last_seen_at gives no behind or offline, but an error still shows', () => {
    expect(attentionReasons(board({ lastSeenAt: null, firmwareVersion: null, sequence: null }), CURRENT, NOW)).toEqual([]);
    expect(attentionReasons(board({ lastSeenAt: null, lastError: 'boom', lastErrorAt: new Date(NOW - 60_000) }), CURRENT, NOW))
      .toEqual([{ kind: 'error', text: 'Error 1m ago: boom' }]);
  });

  it('reasons come in the order error, behind, offline', () => {
    const r = attentionReasons(board({
      lastError: 'e', lastErrorAt: new Date(NOW - H), firmwareVersion: 'old', sequence: 1, lastSeenAt: new Date(NOW - 2 * D),
    }), CURRENT, NOW);
    expect(r.map((x) => x.kind)).toEqual(['error', 'behind', 'offline']);
  });
});

describe('sortAttention', () => {
  it('errors first, then behind, then offline; then most recently seen; never-seen last', () => {
    const rows = [
      { id: 'off-old', reasons: [{ kind: 'offline' as const, text: '' }], lastSeenAt: new Date(NOW - 5 * D) },
      { id: 'behind', reasons: [{ kind: 'behind' as const, text: '' }], lastSeenAt: new Date(NOW - 1000) },
      { id: 'err-never', reasons: [{ kind: 'error' as const, text: '' }], lastSeenAt: null },
      { id: 'off-new', reasons: [{ kind: 'offline' as const, text: '' }], lastSeenAt: new Date(NOW - 2 * D) },
      { id: 'err-new', reasons: [{ kind: 'error' as const, text: '' }], lastSeenAt: new Date(NOW - 5000) },
    ];
    expect(sortAttention(rows).map((r) => r.id)).toEqual(['err-new', 'err-never', 'behind', 'off-new', 'off-old']);
  });

  it('does not mutate its input', () => {
    const rows = [
      { reasons: [{ kind: 'offline' as const, text: '' }], lastSeenAt: null },
      { reasons: [{ kind: 'error' as const, text: '' }], lastSeenAt: null },
    ];
    const copy = [...rows];
    sortAttention(rows);
    expect(rows).toEqual(copy);
  });
});

describe('needsAttention', () => {
  it('drops healthy boards, sorts, and keeps at most ATTENTION_LIMIT', () => {
    const rows = Array.from({ length: 25 }, (_, i) => board({
      deviceId: `e${i}`, lastError: 'x', lastErrorAt: new Date(NOW - H), lastSeenAt: new Date(NOW - i * 1000),
    }));
    rows.push(board({ deviceId: 'healthy' }));
    const out = needsAttention(rows, CURRENT, NOW);
    expect(ATTENTION_LIMIT).toBe(20);
    expect(out).toHaveLength(20);
    expect(out.map((r) => r.deviceId)).not.toContain('healthy');
    expect(out[0].deviceId).toBe('e0');
    expect(out[0].reasons[0].kind).toBe('error');
  });
});

describe('orderDistribution', () => {
  it('newest release first by sequence, unrecognised last, bar sized to the largest count', () => {
    const out = orderDistribution([
      { version: 'weird', count: 1, sequence: null },
      { version: '1.20.2+gdef', count: 4, sequence: 114 },
      { version: '1.21.1+gabc', count: 2, sequence: 119 },
      { version: null, count: 1, sequence: null },
    ], CURRENT.sequence);
    expect(out.map((r) => r.version)).toEqual(['1.21.1+gabc', '1.20.2+gdef', 'weird', null]);
    expect(out.map((r) => r.share)).toEqual([0.5, 1, 0.25, 0.25]);
    expect(out.map((r) => r.recognised)).toEqual([true, true, false, false]);
    expect(out.map((r) => r.current)).toEqual([true, false, false, false]);
  });

  it('unrecognised versions order by count, then name', () => {
    const out = orderDistribution([
      { version: 'b', count: 1, sequence: null },
      { version: 'a', count: 1, sequence: null },
      { version: 'c', count: 3, sequence: null },
    ], null);
    expect(out.map((r) => r.version)).toEqual(['c', 'a', 'b']);
    expect(out.every((r) => !r.current)).toBe(true);
  });

  it('an empty list stays empty', () => {
    expect(orderDistribution([], 5)).toEqual([]);
  });
});

describe('versionLabel', () => {
  it('shows the semver part', () => {
    expect(versionLabel('1.21.1+gabc1234')).toBe('1.21.1');
    expect(versionLabel('0.0.0+e2e-dist-xyz')).toBe('0.0.0');
    expect(versionLabel('1.0.0')).toBe('1.0.0');
    expect(versionLabel(null)).toBe('Unknown');
  });
});
