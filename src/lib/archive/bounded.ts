/**
 * Read a decompression stream to the end, giving up once it has produced more
 * than `maxBytes`. A gzip or deflate stream can expand ~1000:1, so a few MB
 * of input is enough to exhaust memory if the output is collected unbounded --
 * in a browser tab that is a crashed tab, on the server (upload from a URL)
 * it is a crashed function. Returns null when the cap was exceeded.
 */
export async function readBounded(
  stream: ReadableStream<Uint8Array>, maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}
