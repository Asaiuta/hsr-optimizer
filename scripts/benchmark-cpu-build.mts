import { resolve } from 'node:path'
import { build } from 'vite'

const output = process.argv[2]
if (!output) throw Error('Usage: node scripts/benchmark-cpu-build.mts OUTPUT_DIRECTORY')
let installed = false
await build({
  configFile: 'vite.config.ts',
  build: { outDir: resolve(output, 'site') },
  plugins: [{
    name: 'cpu-benchmark-entry',
    enforce: 'pre',
    transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/lib/automation/install.ts')) return
      installed = true
      return source + `
import { resolveRequest as benchResolve } from 'lib/automation/request'
import { runJob as benchRun, getJob as benchJob } from 'lib/automation/jobs'
Object.assign(window, { __cpuBenchmark: {
  inspect(characterId, settings) { return benchResolve({ characterId, settings }).state },
  start(characterId, settings) { return benchJob(benchRun(benchResolve({ characterId, settings }), 'cpu').id) },
} })
`
    },
  }],
})
if (!installed) throw Error('CPU benchmark entry was not installed')
