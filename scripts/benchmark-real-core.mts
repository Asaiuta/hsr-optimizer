import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'

const [input, directory] = process.argv.slice(2)
if (!input || !directory) throw Error('Usage: node scripts/benchmark-real-core.mts SAVE.json OUTPUT_DIRECTORY')
await build({
  configFile: 'vite.headless.config.ts',
  configLoader: 'native',
  build: {
    outDir: resolve(directory, 'core-build'),
    rollupOptions: { input: resolve('scripts/benchmark-real-core.ts'), output: { entryFileNames: 'real-core.mjs' } },
  },
})
const result = await promisify(execFile)(process.execPath, [
  resolve(directory, 'core-build/real-core.mjs'),
  resolve(input),
  resolve(directory, 'core-report.json'),
], { windowsHide: true, maxBuffer: 8 * 1024 ** 2 })
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
