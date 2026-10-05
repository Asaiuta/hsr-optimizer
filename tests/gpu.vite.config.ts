import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/',
  resolve: { tsconfigPaths: true },
  build: {
    target: 'esnext',
    copyPublicDir: false,
    outDir: 'output/gpu-tests/site',
    rollupOptions: { input: resolve(import.meta.dirname, 'Gpu/index.html') },
  },
  preview: { host: '127.0.0.1', strictPort: true },
})
