import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw Error('Usage: node scripts/benchmark-default-plan.mts SAVE.json OUTPUT_DIRECTORY')
await build({
  configFile: 'vite.headless.config.ts',
  configLoader: 'native',
  build: {
    outDir: resolve(output, 'plan-build'),
    rollupOptions: { input: resolve('scripts/benchmark-default-plan.ts'), output: { entryFileNames: 'plan.mjs' } },
  },
})
const result = await promisify(execFile)(process.execPath, [resolve(output, 'plan-build/plan.mjs'), resolve(input), resolve(output)], {
  windowsHide: true,
  maxBuffer: 8 * 1024 ** 2,
})
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
