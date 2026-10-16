// Usage: tsx tools/receive/run-scenarios.ts --port 6800 --dir <host folder> [--host 127.0.0.1] [--only a,b] [--uae]
import { runScenarios } from './scenarios';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const res = await runScenarios(Number(arg('--port') ?? 6800), arg('--dir')!, {
  host: arg('--host'), only: arg('--only')?.split(','), uae: process.argv.includes('--uae'),
});
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ': ' + r.detail : ''}`);
process.exit(res.every((r) => r.ok) ? 0 : 1);
