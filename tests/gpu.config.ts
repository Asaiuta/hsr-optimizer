import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

export default defineConfig({
  testDir: './Gpu',
  timeout: 120000,
  workers: 1,
  outputDir: '../output/gpu-tests/results',
  use: {
    channel: process.env.HSR_BROWSER_CHANNEL ?? 'msedge',
    baseURL: 'http://127.0.0.1:4177',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx vite preview --config tests/gpu.vite.config.ts --port 4177',
    cwd: resolve(import.meta.dirname, '..'),
    url: 'http://127.0.0.1:4177/tests/Gpu/',
    reuseExistingServer: false,
  },
})
