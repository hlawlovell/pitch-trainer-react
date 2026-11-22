import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Browser tests: drive the real app in Chrome. Run with `npm run test:e2e`.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
