import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // `yarn test` is the fast suite: the Chromium tests (tests/*.e2e.test.ts) run only in `yarn test:e2e` (vitest.e2e.config.ts)
    exclude: ['**/node_modules/**', '**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // no test may start a real app: the services are started by Cartoon Studio only when this is not 0
    env: { CTS_AUTOSTART: '0' }
  }
})
