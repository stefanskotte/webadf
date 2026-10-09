import { describe, it, expect } from 'vitest';
import { describeUrlRefusal } from './url-ingest-messages';

describe('describeUrlRefusal', () => {
  it('has words for every code the route sends', () => {
    for (const code of [
      'invalid_url', 'unsupported_scheme', 'credentials_not_allowed', 'port_not_allowed', 'address_not_allowed',
      'unreachable', 'too_many_redirects', 'upstream_status', 'too_large', 'timeout', 'not_a_disk_image',
      'no_disk_images', 'too_many_images', 'unsupported_archive', 'rate_limited', 'store_busy',
    ]) {
      expect(describeUrlRefusal(code)).not.toBe('The fetch failed.');
    }
  });

  it('names a missing file and an upstream status, and nothing else from upstream', () => {
    expect(describeUrlRefusal('upstream_status', 404)).toMatch(/does not exist/);
    expect(describeUrlRefusal('upstream_status', 500)).toMatch(/HTTP 500/);
    expect(describeUrlRefusal('rate_limited', undefined, 30)).toMatch(/30 s/);
    expect(describeUrlRefusal('anything-else')).toBe('The fetch failed.');
  });
});
