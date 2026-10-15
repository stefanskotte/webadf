// Bundles docker/ctl.ts (and the src/selfhost + src/db code it imports) into one ESM file for the image.
import { build } from 'esbuild';
await build({
  entryPoints: ['docker/ctl.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm',
  outfile: 'docker/dist/ctl.mjs', tsconfig: 'tsconfig.json',
  external: ['pg-native', '/app/server.js'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
