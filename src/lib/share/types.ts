// The share API's wire format, protocol 1 (spec §3.2). CLIENT-SAFE: no @/db, no node: imports -- the
// owner's routes (src/app/api/share/v1/) and the recipient's client code both import from here (Ruling P2).

/** Share API protocol version, exchanged at claim and sent on every response. */
export const SHARE_PROTOCOL = 1;

/** One title as a recipient sees it. `collectionIds` lists only the shared collections it is in. */
export type ShareTitle = {
  id: string;
  title: string;
  year: number | null;
  publisher: string | null;
  kind: string | null;
  diskCount: number;
  hasCover: boolean;
  /** Content identifier of the cover the title resolves to right now (also the covers route's ETag); null when none. */
  coverDigest: string | null;
  collectionIds: string[];
};

/** One disk of a shared title. `updatedAt` is ISO; `sha256` is the truth for "did the bytes change". */
export type ShareDisk = {
  id: string;
  name: string;
  diskNo: number;
  sizeBytes: number;
  sha256: string;
  imageFormat: string;
  extractable: boolean;
  updatedAt: string;
};

/** One file or directory on a shared disk, as the local disk files page lists it, dates ISO. */
export type ShareEntry = {
  name: string;
  kind: 'file' | 'dir';
  sizeBytes: number;
  modifiedAt: string | null;
  protection: string;
  comment: string | null;
  children?: ShareEntry[];
};

export type ShareVolume = {
  filesystem: string;
  intl: boolean;
  dirc: boolean;
  name: string;
  createdAt: string | null;
  modifiedAt: string | null;
};

export type ShareUsage = {
  totalBlocks: number;
  usedBlocks: number;
  freeBlocks: number;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  percentUsed: number;
};

// ---- response bodies

export type SharePing = { ok: true; protocol: number };
export type ShareClaimResponse = { token: string; protocol: number; library: { name: string } };
export type ShareLibrary = {
  name: string;
  collections: { id: string; name: string; titles: number }[];
  titles: number;
  disks: number;
};
export type ShareTitlesPage = { titles: ShareTitle[]; nextCursor: string | null };
export type ShareTitleDetail = { title: ShareTitle; disks: ShareDisk[] };
export type ShareFiles =
  | { volume: ShareVolume; root: ShareEntry[]; usage: ShareUsage | null }
  | { unreadable: string };

/** Error bodies. 401 unauthorized (unknown and revoked alike), 404 not_found / invalid_or_used, 409 protocol, 429. */
export type ShareError =
  | { error: 'unauthorized' }
  | { error: 'not_found' }
  | { error: 'invalid_or_used' }
  | { error: 'protocol'; supported: number[] }
  | { error: 'rate_limited' }
  | { error: 'bad_request' }
  | { error: 'unavailable' };

/** Response header every share API answer carries. */
export const SHARE_PROTOCOL_HEADER = 'X-WebFloppy-Share-Protocol';
