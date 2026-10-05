import { resolve } from 'node:path'
import { build } from 'vite'

const output = process.argv[2]
if (!output) throw Error('Usage: node scripts/benchmark-default-build.mts OUTPUT_DIRECTORY')
let patched = false
await build({
  configFile: 'vite.config.ts',
  build: { outDir: resolve(output, 'site') },
  plugins: [{
    name: 'default-benchmark-entry',
    enforce: 'pre',
    transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/lib/automation/install.ts')) return
      patched = true
      // Only the isolated benchmark bundle gets this entry. It bypasses the API's 100-result
      // schema limit, then uses the same request normalization and optimizer as the UI.
      return source + `
import { resolveRequest as benchResolve } from 'lib/automation/request'
import { runJob as benchRun, getJob as benchJob } from 'lib/automation/jobs'
Object.assign(window, { __defaultBenchmark: {
  inspect(characterId) { return benchResolve({ characterId, settings: { resultsLimit: 1024 } }).state },
  start(characterId) {
    const request = benchResolve({ characterId, settings: { resultsLimit: 1024 } })
    return benchJob(benchRun(request, 'gpu').id)
  },
} })
`
    },
  }],
})
if (!patched) throw Error('Benchmark entry was not installed')
