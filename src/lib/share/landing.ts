// The /s/<code> landing page's address field (spec §3.4). CLIENT-SAFE: no node: imports, no @/db.

/**
 * Where the visitor's own WebFloppy's Add page is, for what they typed as its address: "floppy.lan",
 * "https://floppy.lan:8443/", "192.168.1.20". A bare host gets https://. Null when it is not an http(s) address.
 */
export function remoteAddUrl(address: string, link: string): string | null {
  let text = address.trim();
  if (text === '') return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' || url.username || url.password) return null;
  return `${url.origin}/remote/add#link=${encodeURIComponent(link)}`;
}
