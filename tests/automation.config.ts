import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './Automation',
  timeout: 60000,
  workers: 1,
  use: {
    channel: process.env.HSR_BROWSER_CHANNEL ?? 'msedge',
    baseURL: 'http://127.0.0.1:4174/hsr-optimizer/',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run preview -- --port 4174',
    url: 'http://127.0.0.1:4174/hsr-optimizer/',
    reuseExistingServer: false,
  },
})
