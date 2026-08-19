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
    reuseExistingServer: true,
    timeout: 20000,
  },
})
