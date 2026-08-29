// Our side of the differential gate.
//
//   hash <adf>...            -> "<adfPath>\t<trackNo>\t<sha256>" per line
//   dump <adf> <track> <out> -> writes that track's raw MFM bytes
//
// The hash mode takes every ADF in one invocation: 61 separate node startups
// would dominate the runtime of an otherwise fast check.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encodeDisk, readWfmf } from '../src/lib/adfmfm/index';

const [, , mode, ...rest] = process.argv;

if (mode === 'dump') {
  const [adfPath, trackNo, outPath] = rest;
  const tracks = readWfmf(encodeDisk(new Uint8Array(readFileSync(adfPath))));
  writeFileSync(outPath, tracks[Number(trackNo)]);
} else if (mode === 'hash') {
  const lines: string[] = [];
  for (const adfPath of rest) {
    const tracks = readWfmf(encodeDisk(new Uint8Array(readFileSync(adfPath))));
    for (let t = 0; t < tracks.length; t++) {
      lines.push(`${adfPath}\t${t}\t${createHash('sha256').update(tracks[t]).digest('hex')}`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
} else {
  throw new Error('usage: adfmfm-diff.ts hash <adf>... | dump <adf> <track> <out>');
}
