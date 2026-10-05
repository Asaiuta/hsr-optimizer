import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'

await mkdir('output/performance-suite', { recursive: true })
await build({
  configFile: 'vite.headless.config.ts',
  configLoader: 'native',
  build: {
    outDir: 'output/performance-suite/scoring-build',
    rollupOptions: { input: resolve('scripts/benchmark-scoring.ts'), output: { entryFileNames: 'scoring.mjs' } },
  },
})
const result = await promisify(execFile)(process.execPath, ['output/performance-suite/scoring-build/scoring.mjs'], {
  windowsHide: true,
  maxBuffer: 8 * 1024 ** 2,
})
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
