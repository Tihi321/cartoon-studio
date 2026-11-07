import { defineConfig } from 'vitest/config'

/**
 * `yarn test:e2e`: the tests that start Chromium (the render). Slow, so they are not part of `yarn test`. Without Chromium (or ffmpeg) they
 * FAIL, they never skip; an empty run fails too (no `passWithNoTests`).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts'],
    environment: 'node',
    maxWorkers: 2,
    fileParallelism: true,
    retry: 1,
    testTimeout: 180000,
    hookTimeout: 120000,
    env: { CTS_AUTOSTART: '0' }
  }
})
