import { defineConfig, devices } from "@playwright/test";

// Project-local config. Without this file Playwright walks up the folder tree
// and may pick up an unrelated config (e.g. C:\Users\User\playwright.config.ts).
export default defineConfig({
  testDir: "./generated",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
