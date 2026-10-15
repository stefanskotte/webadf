import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('test:db needs TEST_DATABASE_URL -- run `pnpm db:dev start` and export what it prints');
}
// Same alias setup as vitest.config.mts; include/exclude are set outright
// (mergeConfig would concatenate them with the unit config's and run everything).
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: { environment: 'node', include: ['src/**/*.db.test.ts'], fileParallelism: false },
});
