import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/*.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  // drizzle-kit only introspects/diffs the `public` schema by default for
  // `push`/`generate` — without this, tables defined via pgSchema('auth')
  // (src/db/schema/auth.ts) are silently skipped by `db:push`.
  schemaFilter: ['public', 'auth'],
} satisfies Config;
