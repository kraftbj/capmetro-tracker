import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.CAPMETRO_E2E_PORT || 4173)

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    // Pixel 8a and Pixel 10 Pro are the target devices; the design is
    // specified against a 412px CSS width.
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 412, height: 915 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'pixel-412', use: { ...devices['Desktop Chrome'], viewport: { width: 412, height: 915 } } }],
  webServer: {
    command: 'node tests/e2e/server.mjs',
    url: `http://localhost:${PORT}/fresh/index.html`,
    /*
     * Never reuse. A server left running from an earlier run serves ITS copy of
     * the fixtures and its copy of client/, so a suite can pass or fail against
     * a tree nobody is looking at — which has already happened here once, with
     * two stale servers on this port silently answering every request.
     */
    reuseExistingServer: false,
    timeout: 20000,
  },
})
