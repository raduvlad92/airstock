import { defineConfig, devices } from '@playwright/test';

// E2E_PORT lets several checkouts run the smoke test at once.
const port = Number(process.env.E2E_PORT ?? 4173);

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
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node --import tsx ./e2e/server.ts',
    url: `http://localhost:${port}/auth/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
