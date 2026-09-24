import { describe, it, expect } from 'vitest';
import {
  isBlobAlreadyExists, isExpiredPresign, classifyUpload, isUploadableSize, MAX_DISK_BYTES,
  MAX_HFE_PER_BATCH, splitBatches, describeUnuploadableSize, isHfeName,
} from './blob-upload';

// The exact body Vercel Blob returns for a second PUT to a key presigned with
// allowOverwrite: false. Captured verbatim from the real store.
const ALREADY_EXISTS_BODY = JSON.stringify({
  error: {
    code: 'bad_request',
    message: 'This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename. Read more about this error in our documentation: https://vercel.link/blob-allow-overwrite',
  },
});

describe('isBlobAlreadyExists', () => {
  it('recognises the real already-exists 400 from Vercel Blob', () => {
    expect(isBlobAlreadyExists(400, ALREADY_EXISTS_BODY)).toBe(true);
  });

  it('does NOT match other 400s', () => {
    // The oversized-batch 400 our own API returns. Swallowing every 400 would
    // re-hide exactly that bug.
    expect(isBlobAlreadyExists(400, JSON.stringify({
      error: { formErrors: [], fieldErrors: { hashes: ['Too big: expected array to have <=500 items'] } },
    }))).toBe(false);
    // A file rejected for exceeding the signed maximumSizeInBytes must stay a
    // failure -- nothing landed.
    expect(isBlobAlreadyExists(400, JSON.stringify({
      error: { code: 'bad_request', message: 'Your blob exceeds the maximum size' },
    }))).toBe(false);
  });

  it('does not match the message on a non-400 status', () => {
    expect(isBlobAlreadyExists(200, ALREADY_EXISTS_BODY)).toBe(false);
    expect(isBlobAlreadyExists(500, ALREADY_EXISTS_BODY)).toBe(false);
  });
});

describe('isExpiredPresign', () => {
  it('treats 403 as an expired url and nothing else', () => {
    expect(isExpiredPresign(403)).toBe(true);
    expect(isExpiredPresign(400)).toBe(false);
    expect(isExpiredPresign(401)).toBe(false);
    expect(isExpiredPresign(200)).toBe(false);
  });
});

describe('classifyUpload', () => {
  it('calls a 2xx an upload', () => {
    expect(classifyUpload(200, true, '')).toBe('uploaded');
  });

  // THE fix for the self-wedge: the bytes are in the store, so this file must
  // still be sent to /complete. Calling it 'failed' is what excluded it and
  // left it unwritable forever.
  it('calls the already-exists 400 a soft success, not a failure', () => {
    expect(classifyUpload(400, false, ALREADY_EXISTS_BODY)).toBe('already-stored');
  });

  it('calls every other non-2xx a failure', () => {
    expect(classifyUpload(400, false, '{"error":"something else"}')).toBe('failed');
    expect(classifyUpload(403, false, '')).toBe('failed');
    expect(classifyUpload(500, false, '')).toBe('failed');
    expect(classifyUpload(413, false, '')).toBe('failed');
  });
});

describe('isUploadableSize', () => {
  it('accepts a real floppy image', () => {
    expect(isUploadableSize(901_120)).toBe(true); // DD
    expect(isUploadableSize(1_802_240)).toBe(true); // HD
  });

  // The two shapes that actually turn up in a scraped archive. Both are
  // rejected by presignBody, and that 400 fails the presign call for the
  // whole batch -- so the clients have to screen them out themselves.
  it('rejects the truncated zero-byte .adf', () => {
    expect(isUploadableSize(0)).toBe(false);
  });

  it('rejects anything past the server ceiling', () => {
    expect(isUploadableSize(MAX_DISK_BYTES)).toBe(true);
    expect(isUploadableSize(MAX_DISK_BYTES + 1)).toBe(false);
  });

  it('rejects nonsense', () => {
    expect(isUploadableSize(-1)).toBe(false);
    expect(isUploadableSize(1.5)).toBe(false);
    expect(isUploadableSize(NaN)).toBe(false);
  });
});

describe('MAX_DISK_BYTES', () => {
  it('is 2.25 MiB', () => {
    expect(MAX_DISK_BYTES).toBe(2_359_296);
  });

  // The two largest legitimate images: an HD ADF, and an 84-cylinder HFE v1
  // at the board's longest track (13,312 B a side). 2 MiB refused the second.
  it('admits an HD ADF and the largest HFE the spec accepts', () => {
    expect(isUploadableSize(1_802_240)).toBe(true);
    expect(isUploadableSize(1024 + 84 * 2 * 13_312)).toBe(true);
    expect(isUploadableSize(2_359_296 + 1)).toBe(false);
  });
});

describe('describeUnuploadableSize', () => {
  it('states the size and the limit for an oversize file', () => {
    expect(describeUnuploadableSize('Big.hfe', 2_516_582)).toBe('Big.hfe is 2.4 MB; the limit is 2.25 MB');
  });

  it('says a zero-byte file is empty', () => {
    expect(describeUnuploadableSize('Trunc.adf', 0)).toBe('Trunc.adf is empty (0 bytes)');
  });
});

describe('splitBatches', () => {
  const names = (prefix: string, n: number, ext: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}.${ext}`);
  const id = (s: string) => s;

  it('splits a list with no HFE exactly like a plain chunk', () => {
    const out = splitBatches(names('a', 1001, 'adf'), id, 500, 50);
    expect(out.map((b) => b.length)).toEqual([500, 500, 1]);
  });

  it('never puts more than maxHfe HFE files in one batch', () => {
    const out = splitBatches(names('h', 120, 'hfe'), id, 500, 50);
    expect(out.map((b) => b.length)).toEqual([50, 50, 20]);
  });

  it('fills a batch with ADFs around its HFE quota and keeps order', () => {
    const items = [...names('h', 60, 'HFE'), ...names('a', 10, 'adf')];
    const out = splitBatches(items, id, 500, 50);
    expect(out.map((b) => b.length)).toEqual([50, 20]);
    expect(out.flat()).toEqual(items);
    for (const b of out) expect(b.filter(isHfeName).length).toBeLessThanOrEqual(50);
  });

  it('honours both caps at once', () => {
    const items = [...names('a', 480, 'adf'), ...names('h', 60, 'hfe')];
    const out = splitBatches(items, id, 500, MAX_HFE_PER_BATCH);
    for (const b of out) {
      expect(b.length).toBeLessThanOrEqual(500);
      expect(b.filter(isHfeName).length).toBeLessThanOrEqual(MAX_HFE_PER_BATCH);
    }
    expect(out.flat()).toEqual(items);
    expect(out.map((b) => b.length)).toEqual([500, 40]);
  });

  it('returns no batches for no files', () => {
    expect(splitBatches([], id, 500, 50)).toEqual([]);
  });
});

