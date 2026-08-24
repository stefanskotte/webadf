import { describe, it, expect } from 'vitest';
import {
  isBlobAlreadyExists, isExpiredPresign, classifyUpload, isUploadableSize, MAX_DISK_BYTES,
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
