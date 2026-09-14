import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { gzipLines, textLines } from './lines';

async function collect(it: AsyncIterable<string>) {
  const out: string[] = [];
  for await (const l of it) out.push(l);
  return out;
}

describe('gzipLines', () => {
  it('decompresses a web stream and splits it into lines', async () => {
    const gz = gzipSync(Buffer.from('COPY x\nrow\\tone\n\\.\n'));
    const stream = new Blob([gz]).stream();
    expect(await collect(gzipLines(stream))).toEqual(['COPY x', 'row\\tone', '\\.']);
  });
});

describe('textLines', () => {
  it('splits text without a trailing empty line', async () => {
    expect(await collect(textLines('a\nb\n'))).toEqual(['a', 'b']);
  });
});
