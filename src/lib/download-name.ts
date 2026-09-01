// What a downloaded disk image is called, and how that name is safely put
// into a response header.
//
// Both halves are here because both are about untrusted text.
// `entitlements.sourceFilename` is whatever an uploader sent -- the ingest
// path stores it verbatim, which is right, since it is a record of what they
// called the file -- so by the time it reaches a Content-Disposition header
// it has crossed from data into protocol and has to be treated as hostile.

/** Extension the whole system deals in. */
const EXT = '.adf';

/**
 * The disk's best known name, else what this tenant uploaded, else the digest.
 *
 * `tosecName` is NOT always TOSEC's, despite the column name: ingest seeds it
 * with the uploaded filename and the identity scan later overwrites it with
 * the canonical rom name. So preferring it means "canonical once known,
 * otherwise the uploader's own name" -- which is the desired behaviour either
 * way, and roughly 46% of a real archive gets the canonical form.
 *
 * sourceFilename still matters as a fallback because it is per-TENANT: the
 * disk row is shared shape, while the entitlement records what THIS
 * organization called the file. The digest fallback is never pretty but is
 * always correct and always unique.
 */
export function downloadFilename(
  tosecName: string | null | undefined,
  sourceFilename: string | null | undefined,
  sha256: string,
  ext: string = EXT,
): string {
  const chosen = base(tosecName) ?? base(sourceFilename) ?? sha256;
  if (ext === '') return chosen;
  return chosen.toLowerCase().endsWith(ext.toLowerCase()) ? chosen : `${chosen}${ext}`;
}

/**
 * Trim, drop any directory part, and reject what is left if it is empty.
 *
 * The path strip is not defence against traversal on OUR disk -- nothing here
 * opens a file by this name -- but the value is handed to a browser as the
 * name to save under, and a stored name like `../../x` should not arrive
 * looking like a path at all.
 */
function base(name: string | null | undefined): string | null {
  if (!name) return null;
  const last = name.trim().split(/[/\\]/).pop() ?? '';
  return last.length > 0 ? last : null;
}

/**
 * A complete Content-Disposition value carrying both forms RFC 6266 defines.
 *
 * `filename=` is a quoted-string and is ASCII-only, so it is sanitised down
 * to something safe and readable; `filename*=` carries the real name in
 * UTF-8 and is what every current browser actually uses.
 *
 * CR and LF are removed FIRST and unconditionally. A newline reaching a
 * response header splits it, letting a crafted upload name append headers of
 * its own -- and this name is user-supplied.
 */
export function contentDisposition(filename: string): string {
  const clean = filename.replace(/[\r\n]/g, '');

  // Quoted-string form: printable ASCII only, with the two characters that
  // can end the quoting early (" and \) replaced rather than escaped, since
  // a saved filename gains nothing from carrying them.
  const ascii = [...clean]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (ch === '"' || ch === '\\') return '_';
      return code >= 0x20 && code <= 0x7e ? ch : '_';
    })
    .join('') || 'disk.adf';

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
