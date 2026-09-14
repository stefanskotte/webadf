import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

/** A gzip web stream as lines, never buffered whole: the export is ~200 MB gzipped. */
export function gzipLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const input = Readable.fromWeb(stream as unknown as NodeWebReadableStream<Uint8Array>)
    .pipe(createGunzip());
  return createInterface({ input, crlfDelay: Infinity });
}

/** Test helper and fixture reader: the same line contract over an in-memory string. */
export async function* textLines(text: string): AsyncGenerator<string> {
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  for (const p of parts) yield p;
}
