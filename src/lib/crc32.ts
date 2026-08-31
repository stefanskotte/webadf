// CRC32 (IEEE 802.3, reflected, poly 0xEDB88320) -- the variant TOSEC DAT
// files use. node:crypto has no CRC32, and this is ~20 lines, so it is
// written here rather than adding a dependency, the same reasoning that
// keeps src/lib/adfmfm dependency-free.

const TABLE = /* @__PURE__ */ (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** 8 lowercase hex characters, zero-padded. */
export function crc32(bytes: Uint8Array): string {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  // >>> 0 forces the unsigned reading before formatting; without it a value
  // with the high bit set formats as a negative number.
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
