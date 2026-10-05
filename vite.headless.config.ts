import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  build: {
    ssr: true,
    outDir: 'output/headless',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'scripts/automation-headless.ts'),
      output: { entryFileNames: 'automation-headless.mjs' },
    },
  },
})
