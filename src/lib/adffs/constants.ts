// Every value here comes from docs/superpowers/specs/2026-09-01-adf-filesystem-reader-design.md
// section 3, which measured them against the operator's archive rather than
// taking them from the format documentation. Do not "tidy" any of them.

export const BLOCK_BYTES = 512;
/** 880 KB / 512. A non-standard image is out of scope; assertAdf rejects it. */
export const BLOCK_COUNT = 1760;
/** The midpoint of the disk. Fixed, not derived: see spec section 3.1. */
export const ROOT_BLOCK = 880;
export const HASH_TABLE_SIZE = 72;

/** Word index of the checksum in root, directory and file-header blocks. */
export const CHECKSUM_WORD = 5;
/** Word index of the checksum in an OFS data block's 24-byte header. */
export const OFS_DATA_CHECKSUM_WORD = 5;
/** An OFS data block spends 24 bytes on a header, leaving this much payload. */
export const OFS_DATA_BYTES = 488;

export const T_HEADER = 2;
export const T_DATA = 8;
export const T_LIST = 16;

export const ST_ROOT = 1;
export const ST_USERDIR = 2;
/** Stored as 0xfffffffd. MUST be compared as a SIGNED value -- see i32. */
export const ST_FILE = -3;

/**
 * Caps from spec section 5. The real archive's largest disk holds a few
 * hundred entries at depth 4, so these bound a crafted image without
 * constraining any real one.
 */
export const MAX_ENTRIES = 10_000;
export const MAX_DEPTH = 32;
