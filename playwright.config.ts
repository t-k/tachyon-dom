import { defineConfig, devices } from "@playwright/test";

const browserServerPort = Number(process.env.PLAYWRIGHT_SERVER_PORT ?? process.env.PORT ?? 4173);

export default defineConfig({
  testDir: "./tests/browser",
  globalSetup: "./tests/browser/global-setup.mjs",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${browserServerPort}`,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `python3 -m http.server ${browserServerPort} --bind 127.0.0.1 --directory .`,
    url: `http://127.0.0.1:${browserServerPort}`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
