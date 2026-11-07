import { defineConfig } from 'vitest/config'

/**
 * `yarn test:e2e`: the tests that start Chromium (the render). Slow, so they are not part of `yarn test`. Without Chromium they FAIL, they
 * never skip. The render test itself comes with CTS-05.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts'],
    environment: 'node',
    maxWorkers: 2,
    fileParallelism: true,
    retry: 1,
    testTimeout: 120000,
    hookTimeout: 120000,
    passWithNoTests: true,
    env: { CTS_AUTOSTART: '0' }
  }
})
