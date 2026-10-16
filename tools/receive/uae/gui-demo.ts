// Fills Receive's window for a screenshot: four files listed, one delivered, one arriving slowly, two waiting.
// Usage: tsx tools/receive/uae/gui-demo.ts   (prints "capture now" while the second file is mid-transfer)
import { connect } from '../fake-board';

const files = [
  { id: 'w1', path: 'Turrican2.lha', data: Buffer.alloc(420000, 1) },
  { id: 'w2', path: 'mods/axelf.mod', data: Buffer.alloc(58000, 2) },
  { id: 'w3', path: 'Lemmings.adf', data: Buffer.alloc(901120, 3) },
  { id: 'w4', path: 'Readme.txt', data: Buffer.from('hi') },
];
const b = await connect(6800);
b.list(files);
console.log(await b.send(files[3]));
b.list(files.slice(0, 3));
const p = b.send(files[0], { chunk: 2048, delayMs: 40 });
await new Promise((r) => setTimeout(r, 6000));
console.log('capture now');
console.log(await p);
await b.close();
