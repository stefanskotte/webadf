import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * No client component may reach the database driver, even transitively.
 *
 * Under neon-http this never mattered: @neondatabase/serverless is fetch-based
 * and compiles for the browser, so a 'use client' file that imported a pure
 * helper from a module which ALSO held a query (device-name.ts, second-drive.ts)
 * dragged @/db into the client bundle harmlessly. node-postgres needs `net`,
 * `tls`, `dns` and `util/types`, so the same import graph fails to compile and
 * takes down every page under the (app) layout (self-hosting P1, Task 6: the
 * whole e2e suite timed out on `active-org`). Pure helpers a client component
 * uses live in a module with no database import; the query sits beside it in
 * a *-store / server module.
 */
const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const DB = path.join(SRC, 'db', 'index.ts');
const SERVER_ONLY = new Set(['pg', '@vercel/blob', 'node:fs', 'node:fs/promises', 'node:crypto', 'node:path']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return `pkg:${spec}`;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Value imports and re-exports only: `import type` and all-`type` braces are erased at compile time. */
function deps(file: string): string[] {
  const s = fs.readFileSync(file, 'utf8');
  const re = /^\s*(?:import|export)\s+(?!type\b)([^'";]*?from\s+)?['"]([^'"]+)['"]/gm;
  const out: string[] = [];
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const clause = (m[1] ?? '').trim();
    if (/^\{\s*(type\s+\w+\s*,?\s*)+\}\s*from$/.test(clause)) continue;
    const r = resolve(file, m[2]);
    if (r) out.push(r);
  }
  return out;
}

function offendingChains(): string[] {
  const chains: string[] = [];
  for (const f of walk(SRC)) {
    if (!/^\s*['"]use client['"]/.test(fs.readFileSync(f, 'utf8'))) continue;
    const prev = new Map<string, string | null>([[f, null]]);
    const queue = [f];
    while (queue.length) {
      const x = queue.shift()!;
      if (x.startsWith('pkg:')) continue;
      for (const d of deps(x)) {
        if (prev.has(d)) continue;
        prev.set(d, x);
        if (d === DB || SERVER_ONLY.has(d.replace(/^pkg:/, ''))) {
          const chain = [d];
          for (let y: string | null | undefined = x; y; y = prev.get(y)) chain.push(y);
          chains.push(chain.reverse().map((c) => path.relative(ROOT, c)).join(' -> '));
        } else queue.push(d);
      }
    }
  }
  return chains;
}

describe('client bundle boundary', () => {
  it('no client component imports the database or a server-only package, even transitively', () => {
    expect(offendingChains()).toEqual([]);
  });
});
