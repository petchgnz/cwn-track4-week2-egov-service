import { defineConfig } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'off',
    video: process.env.PW_VIDEO ? 'on' : 'off',
    screenshot: 'off',
    viewport: { width: 1280, height: 720 },
  },
});
