// Shows Transfer's window answering the web app (spec 2026-10-30 §2.3): a VOLS and a DIR, so the status line reads
// "Web: listed Work:Up". uae-test.sh's gui mode starts Transfer with BROWSE and two queued uploads; the requests wait
// behind them (spec §3 arbitration), so the demo takes both files first.
// Usage: tsx tools/receive/uae/browse-demo.ts
import { connect } from '../fake-board';

const b = await connect(6800, '127.0.0.1', { v: 3 });
await b.takeUpload({ timeoutMs: 120000 });   // Lemmings.adf, 900 KB
await b.takeUpload({ timeoutMs: 60000 });    // Notes.txt
console.log(`READY 3 ${b.browse ? 1 : 0}`);
console.log((await b.request('VOLS demo1')).join('\n'));
console.log((await b.request('DIR demo2 7:Work:Up')).join('\n'));
console.log('capture now');
await new Promise((r) => setTimeout(r, 5000));
await b.close();
