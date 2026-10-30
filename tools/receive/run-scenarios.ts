// Usage: tsx tools/receive/run-scenarios.ts --port 6800 (--dir <host folder> | --browse) [--host 127.0.0.1] [--only a,b] [--uae]
import { runScenarios, runBrowseScenarios } from './scenarios';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
// --browse: the protocol 3 scenarios (FS-UAE's browse mode); otherwise the shared download scenarios.
const res = process.argv.includes('--browse')
  ? await runBrowseScenarios(Number(arg('--port') ?? 6800), {}, { host: arg('--host'), only: arg('--only')?.split(','), uae: process.argv.includes('--uae') })
  : await runScenarios(Number(arg('--port') ?? 6800), arg('--dir')!, {
      host: arg('--host'), only: arg('--only')?.split(','), uae: process.argv.includes('--uae'),
    });
for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ': ' + r.detail : ''}`);
process.exit(res.every((r) => r.ok) ? 0 : 1);
