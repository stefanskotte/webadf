// Fills Transfer's window for a screenshot: an upload moving "to web", another waiting, and three downloads waiting
// beside them (a download never moves during an upload: spec §3 arbitration). uae-test.sh's gui mode starts Transfer
// with Work:Up/Lemmings.adf and Work:Up/Notes.txt queued.
// Usage: tsx tools/receive/uae/gui-demo.ts   (prints "capture now" while Lemmings.adf goes up)
import { connect } from '../fake-board';

const files = [
  { id: 'w1', path: 'Turrican2.lha', data: Buffer.alloc(420000, 1) },
  { id: 'w2', path: 'mods/axelf.mod', data: Buffer.alloc(58000, 2) },
  { id: 'w4', path: 'Readme.txt', data: Buffer.from('hi') },
];
const b = await connect(6800, '127.0.0.1', { v: 2 });
const up = b.takeUpload({ delayMoreMs: 4000, timeoutMs: 120000 });   // Lemmings.adf goes up slowly
await new Promise((r) => setTimeout(r, 1000));
b.list(files);                                                       // LIST needs no reply, so it may cross the upload
await new Promise((r) => setTimeout(r, 8000));
console.log('capture now');
console.log(JSON.stringify({ ...(await up), data: undefined }));
await b.close();
