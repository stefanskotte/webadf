/** `attachment` with an ASCII fallback name and the real one as RFC 5987 filename*; no quote, CR, LF or `;` can get out. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  let star: string;
  try { star = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
  catch { return `attachment; filename="${ascii}"`; }   // a lone surrogate cannot be UTF-8 encoded: the ASCII name only
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}
