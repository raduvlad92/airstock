import { defineConfig, devices } from '@playwright/test';

/**
 * One Chromium smoke test against the real app (plan N0, 7.1). `pnpm build` first: the server
 * serves the built dashboard from apps/worker/public/app.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --import tsx ./e2e/server.ts',
    url: 'http://localhost:4173/auth/login',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
