// What the upload page says for each /api/ingest/url refusal. Client-safe
// (no server imports), and the only place these words live: the route sends
// codes, never the upstream's own text.

export function describeUrlRefusal(code: string, status?: number, retryAfter?: number): string {
  switch (code) {
    case 'invalid_url': return 'That is not a valid web address.';
    case 'unsupported_scheme': return 'Only http:// and https:// addresses can be fetched.';
    case 'credentials_not_allowed': return 'Addresses with a user name or password in them are not fetched.';
    case 'port_not_allowed': return 'Only the standard web ports (80 and 443) can be fetched.';
    case 'address_not_allowed': return 'That address points to a private or local network, which is not fetched.';
    case 'unreachable': return 'The server could not be reached.';
    case 'too_many_redirects': return 'The address redirected too many times.';
    case 'upstream_status':
      return status === 404 || status === 410
        ? 'The server says that file does not exist.'
        : `The server refused the download${status ? ` (HTTP ${status})` : ''}.`;
    case 'too_large': return 'The download is larger than 20 MB.';
    case 'timeout': return 'The download took too long.';
    case 'not_a_disk_image': return 'That download is not an ADF, ADZ, DMS or HFE disk image (or a .zip of them).';
    case 'no_disk_images': return 'The .zip has no disk images in it.';
    case 'too_many_images': return 'The .zip holds more than 20 disk images; upload them from your computer instead.';
    case 'unsupported_archive': return 'Only .zip archives can be unpacked here; LHA, 7z and RAR cannot yet.';
    case 'rate_limited':
      return `Too many fetches in a row${retryAfter ? `; try again in ${retryAfter} s` : ''}.`;
    case 'store_busy': return 'Storage is busy right now; try again in a moment.';
    default: return 'The fetch failed.';
  }
}
