// Fills Transfer's window to see Transfer 2.14: more rows than the list shows, then a slow file, relative and on a volume.
// uae-test.sh's gui mode starts Transfer with BROWSE WRITE; it also queues two uploads, which go first. Prints when to look.
// Usage: tsx tools/receive/uae/row-demo.ts
import { connect } from '../fake-board';

const b = await connect(6800, '127.0.0.1', { v: 6 });
const up = b.takeUpload({ timeoutMs: 120000 });
console.log(JSON.stringify({ ...(await up), data: undefined }));
const up2 = b.takeUpload({ timeoutMs: 120000 });
console.log(JSON.stringify({ ...(await up2), data: undefined }));
for (let i = 1; i <= 12; i++) await b.send({ id: `s${i}`, path: `small${i}.txt`, data: Buffer.alloc(900, i) });
console.log('12 small files done');
const slow = b.send({ id: 'big', path: 'Work:Out/Monkey/DISK04.LEC', mode: 'replace', data: Buffer.alloc(400 * 1024, 7) } as never, { chunk: 16384, delayMs: 700 });
await new Promise((r) => setTimeout(r, 9000));
console.log('capture: the slow file on its way');
console.log(JSON.stringify(await slow.catch((e: Error) => ({ error: e.message }))));
console.log('capture: the slow file done');
await new Promise((r) => setTimeout(r, 8000));
await b.close();
