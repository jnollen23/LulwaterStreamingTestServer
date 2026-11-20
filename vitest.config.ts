import { defineConfig } from 'vitest/config';

/**
 * Logic tests (npm test). Everything AWS is mocked, so they run offline and cost nothing.
 * Backend and script tests run in Node; the frontend tests cover plain functions only (no React rendering).
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    unstubEnvs: true,
  },
});
