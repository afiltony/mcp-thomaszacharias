import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: { VITEST: 'true' },
    // Database-backed runs share one database per worker; run files one at a time there.
    fileParallelism: process.env.TEST_STORE !== 'postgres',
  },
});
