import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises'
import {
  cpus,
  totalmem,
} from 'node:os'
import { performance } from 'node:perf_hooks'
import { chromium } from 'playwright'
import { preview } from 'vite'
import type { HsrOptimizerSaveFormat } from '../src/types/store.ts'

// Diagnostic wrappers report CPU API duration and asynchronous wait, not GPU kernel time.
function installProbe() {
  const state = {
    phases: {} as Record<string, { calls: number, totalMs: number, maxMs: number }>,
    workers: 0,
    liveGpuBytes: 0,
    peakGpuBytes: 0,
    longTasks: [] as number[],
    workerSamples: [] as { prepareMs: number, computeMs: number, width: number, passed: number }[],
  }
  const mark = (name: string, duration: number) => {
    const phase = state.phases[name] ??= { calls: 0, totalMs: 0, maxMs: 0 }
    phase.calls++
    phase.totalMs += duration
    phase.maxMs = Math.max(phase.maxMs, duration)
  }
  Object.assign(window, { __perf: state })
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) state.longTasks.push(entry.duration)
  }).observe({ type: 'longtask', buffered: true })
  const OriginalWorker = window.Worker
  window.Worker = class extends OriginalWorker {
    pending: number | undefined
    constructor(url: string | URL, options?: WorkerOptions) {
      const start = performance.now()
      super(url, options)
      state.workers++
      let ready = false
      this.addEventListener('message', (event) => {
        if (event.data?.__benchWorker) state.workerSamples.push(event.data.__benchWorker)
        if (!ready) {
          mark('workerFirstMessage', performance.now() - start)
          ready = true
        }
        if (this.pending !== undefined) {
          mark('workerRoundTrip', performance.now() - this.pending)
          this.pending = undefined
        }
      })
    }
    override postMessage(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []) {
      const start = performance.now()
      this.pending = start
      if (Array.isArray(transfer)) super.postMessage(message, transfer)
      else super.postMessage(message, transfer)
      mark('workerPostMessage', performance.now() - start)
    }
  }
  function timedAsync(target: object, name: string) {
    const record = target as Record<string, (...args: unknown[]) => Promise<unknown>>
    const original = record[name]
    record[name] = async function(...args: unknown[]) {
      const start = performance.now()
      try {
        return await original.apply(this, args)
      } finally {
        mark(name, performance.now() - start)
      }
    }
  }
  if (typeof GPUDevice !== 'undefined') {
    timedAsync(GPUDevice.prototype, 'createComputePipelineAsync')
    timedAsync(GPUBuffer.prototype, 'mapAsync')
    const sizes = new WeakMap<GPUBuffer, number>()
    const create = GPUDevice.prototype.createBuffer
    GPUDevice.prototype.createBuffer = function(descriptor: GPUBufferDescriptor) {
      const buffer = create.call(this, descriptor)
      sizes.set(buffer, descriptor.size)
      state.liveGpuBytes += descriptor.size
      state.peakGpuBytes = Math.max(state.peakGpuBytes, state.liveGpuBytes)
      return buffer
    }
    const destroy = GPUBuffer.prototype.destroy
    GPUBuffer.prototype.destroy = function() {
      state.liveGpuBytes -= sizes.get(this) ?? 0
      sizes.delete(this)
      return destroy.call(this)
    }
  }
}

const directory = 'output/performance-suite'
const diagnostic = process.argv.includes('--diagnostic')
const searchOnly = process.argv.includes('--large-search')
const dist = diagnostic ? `${directory}/diagnostic-site` : 'dist'
await mkdir(directory, { recursive: true })
const sourceText = await readFile('src/data/sample-save.json', 'utf8')
const source = JSON.parse(sourceText) as HsrOptimizerSaveFormat
const character = source.characters.find((entry) => entry.id === '1212b1')!
const ids = new Set(Object.values(character.equipped))
const originalRelics = source.relics.filter((entry) => ids.has(entry.id))
function inventory(count: number) {
  return JSON.stringify({
    characters: [{ ...character, builds: [] }],
    relics: Array.from({ length: count }, (_, index) => {
      const original = originalRelics[index % 6]
      return {
        ...original,
        id: index < 6 ? original.id : `bench-${index}`,
        equippedBy: index < 6 ? character.id : undefined,
        substats: original.substats.map((stat) => ({ ...stat, value: stat.value + (index < 6 ? 0 : (index % 13) * 0.1) })),
      }
    }),
  })
}
const settings = {
  keepCurrentRelics: false,
  includeEquippedRelics: true,
  rankFilter: false,
  enhance: 0,
  grade: 2,
  mainBody: [],
  mainFeet: [],
  mainPlanarSphere: [],
  mainLinkRope: [],
  setFilters: { fourPiece: [], twoPieceCombos: [], ornaments: [] },
  resultsLimit: 10,
  resultSort: 'COMBO',
}
const report: Record<string, any> = {
  timestamp: new Date().toISOString(),
  environment: { node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, totalmem: totalmem() },
  sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
  diagnostic,
  distHtmlSha256: createHash('sha256').update(await readFile(`${dist}/index.html`)).digest('hex'),
  notes: [
    'Local production preview; isolated Chromium profile; deterministic synthetic inventory.',
    'Diagnostic API wrappers add overhead. Worker round trip includes compute, queueing and message transfer.',
    'GPU mapAsync is wall wait, not kernel time; GPU bytes are requested buffers, not measured VRAM.',
    'Job completion polled every 10 ms inside renderer. Three runs are descriptive, not reliable P95.',
  ],
  search: [],
  inventory: [],
  workflows: [],
  errors: [],
}
const server = await preview({ configFile: 'vite.config.ts', build: { outDir: dist }, preview: { port: 4175, strictPort: true, open: false } })
const launched = performance.now()
const browser = await chromium.launch({ channel: process.env.HSR_BROWSER_CHANNEL ?? 'msedge', headless: true })
report.browserLaunchMs = performance.now() - launched
const page = await browser.newPage()
const cdp = await page.context().newCDPSession(page)
await cdp.send('Performance.enable')
await page.addInitScript(installProbe)
const pageErrors: string[] = []
page.on('pageerror', (error) => pageErrors.push(error.message))
async function checkpoint() {
  await writeFile(`${directory}/${searchOnly ? 'large-' : ''}${diagnostic ? 'diagnostic-' : ''}browser-report.json`, JSON.stringify(report, null, 2))
}
async function memory() {
  const metrics = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(
    metrics.metrics.filter((entry) => ['JSHeapUsedSize', 'JSHeapTotalSize', 'TaskDuration', 'ScriptDuration', 'Nodes', 'JSEventListeners'].includes(entry.name))
      .map((entry) => [entry.name, entry.value]),
  )
}
async function call(name: string, input: unknown = {}) {
  return page.evaluate(async ({ name, input }) => {
    const start = performance.now()
    const result = await window.hsrAutomation.call(name, input)
    if (!result.ok) throw new Error(JSON.stringify(result))
    return { ms: performance.now() - start, data: result.data as any }
  }, { name, input })
}
async function search(engine: string, options: typeof settings) {
  return page.evaluate(async ({ engine, options }) => {
    const metrics = (window as any).__perf
    metrics.phases = {}
    metrics.workerSamples = []
    ;(window as any).__hsrPhases = {}
    metrics.longTasks = []
    metrics.peakGpuBytes = metrics.liveGpuBytes
    const start = performance.now()
    const response = await window.hsrAutomation.call('start_optimization', { characterId: '1212b1', settings: options, engine }) as any
    if (!response.ok) throw Error(JSON.stringify(response))
    const submittedMs = performance.now() - start
    const jobId = response.data.jobId
    let status: any
    do {
      await new Promise((resolve) => setTimeout(resolve, 10))
      status = await window.hsrAutomation.call('get_job', { jobId }) as any
      if (performance.now() - start > 120000) {
        await window.hsrAutomation.call('cancel_job', { jobId })
        throw Error(`Search timeout ${engine}`)
      }
    } while (status.data?.status === 'running')
    const completedMs = performance.now() - start
    if (status.data?.status !== 'completed') throw Error(JSON.stringify(status))
    const result = await window.hsrAutomation.call('get_results', { jobId, limit: 100 }) as any
    if (!result.ok) throw Error(JSON.stringify(result))
    return {
      submittedMs,
      completedMs,
      status: status.data,
      results: result.data.results,
      metrics: structuredClone(metrics),
      stages: (window as any).__hsrPhases,
    }
  }, { engine, options })
}
try {
  const navigation = performance.now()
  await page.goto('http://127.0.0.1:4175/hsr-optimizer/')
  await page.waitForFunction(() => !!window.hsrAutomation)
  report.pageReadyMs = performance.now() - navigation
  report.firstCall = await call('list_characters')
  const adapter = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter()
    return adapter
      ? {
        info: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description },
        timestampQuery: adapter.features.has('timestamp-query'),
      }
      : null
  })
  report.gpu = adapter
  report.initialMemory = await memory()
  for (const perSlot of searchOnly ? [12] : [2, 4, 6, 10]) {
    await call('import_save', { json: inventory(perSlot * 6) })
    for (const engine of adapter ? ['cpu', 'gpu'] : ['cpu']) {
      for (let iteration = 0; iteration < 3; iteration++) {
        const result = await search(engine, settings)
        assert.equal(result.status.permutations, perSlot ** 6)
        assert.equal(result.status.resultCount, 10)
        const verified = []
        for (const row of result.results) {
          const simulation = await call('simulate_build', { characterId: character.id, settings, relicIds: Object.values(row.relics) })
          const relativeError = Math.abs(simulation.data.stats.COMBO / row.stats.COMBO - 1)
          assert.ok(relativeError < 1e-5, `Score mismatch: ${relativeError}`)
          verified.push(relativeError)
        }
        const entry = { perSlot, engine, iteration, ...result, verified, memory: await memory() }
        report.search.push(entry)
        await checkpoint()
        process.stderr.write(`Search ${perSlot ** 6} ${engine} #${iteration}: ${result.completedMs.toFixed(1)} ms\n`)
      }
    }
  }
  if (!searchOnly) {
    // Same workload, different rejection/selectivity and retained-result requirements.
    await call('import_save', { json: inventory(36) })
    for (const resultsLimit of [1, 100]) {
      for (const engine of adapter ? ['cpu', 'gpu'] : ['cpu']) {
        report.search.push({ kind: 'topK', resultsLimit, engine, ...await search(engine, { ...settings, resultsLimit }) })
      }
    }
    for (const engine of adapter ? ['cpu', 'gpu'] : ['cpu']) {
      const result = await search(engine, { ...settings, statFilters: { minSpd: 10000 } } as typeof settings)
      assert.equal(result.status.resultCount, 0)
      report.search.push({ kind: 'noResults', engine, ...result })
    }
    if (diagnostic) {
      const constrained = JSON.parse(inventory(36)) as HsrOptimizerSaveFormat
      constrained.relics.forEach((relic, index) => {
        if (['Head', 'Hands', 'Body', 'Feet'].includes(relic.part)) {
          relic.set = Math.floor(index / 6) % 2
            ? 'Passerby of Wandering Cloud'
            : 'Musketeer of Wild Wheat'
        }
      })
      await call('import_save', { json: JSON.stringify(constrained) })
      for (const engine of adapter ? ['cpu', 'gpu'] : ['cpu']) {
        const result = await search(
          engine,
          { ...settings, setFilters: { fourPiece: ['Musketeer of Wild Wheat'], twoPieceCombos: [], ornaments: [] } } as typeof settings,
        )
        assert.equal(result.status.permutations, 3 ** 4 * 6 ** 2)
        report.search.push({ kind: 'setConstraint', engine, ...result })
      }
    }
    for (const count of [162, 1000, 5000, 10000]) {
      const json = inventory(count)
      for (let iteration = 0; iteration < 3; iteration++) {
        const imported = await call('import_save', { json })
        assert.equal(imported.data.relics, count)
        const exported = await call('export_save')
        const list = await call('list_relics', { offset: Math.max(0, count - 100), limit: 100 })
        assert.equal(list.data.total, count)
        const diff = await call('compare_inventory', { json: exported.data })
        assert.equal(diff.data.total, 0)
        report.inventory.push({
          count,
          iteration,
          inputBytes: Buffer.byteLength(json),
          importMs: imported.ms,
          exportMs: exported.ms,
          exportBytes: Buffer.byteLength(exported.data),
          lastPageMs: list.ms,
          identicalDiffMs: diff.ms,
          memory: await memory(),
        })
        await checkpoint()
      }
      process.stderr.write(`Inventory ${count} completed\n`)
    }
    await call('import_save', { json: inventory(24) })
    for (const scenarios of [1, 8, 32]) {
      const start = performance.now()
      const batch = await call('start_batch', { engine: 'cpu', requests: Array.from({ length: scenarios }, () => ({ characterId: character.id, settings })) })
      let status
      do {
        await new Promise((resolve) => setTimeout(resolve, 20))
        status = await call('get_batch', { batchId: batch.data.batchId })
      } while (status.data.status === 'running' && performance.now() - start < 120000)
      assert.equal(status.data.status, 'completed')
      assert.equal(status.data.scenarios.length, scenarios)
      report.workflows.push({ kind: 'batch', scenarios, elapsedMs: performance.now() - start, submitMs: batch.ms, memory: await memory() })
      await checkpoint()
    }
    await call('import_save', { json: inventory(600) })
    for (const engine of adapter ? ['cpu', 'gpu'] : ['cpu']) {
      const started = await call('start_optimization', { characterId: character.id, settings, engine })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const cancelled = await call('cancel_job', { jobId: started.data.jobId })
      assert.equal(cancelled.data.status, 'cancelled')
      await new Promise((resolve) => setTimeout(resolve, 500))
      report.workflows.push({
        kind: 'cancel',
        engine,
        cancelApiMs: cancelled.ms,
        memory: await memory(),
        probe: await page.evaluate(() => (window as any).__perf),
      })
    }
    const startMemory = await memory()
    const start = performance.now()
    await page.evaluate(async () => {
      for (let i = 0; i < 2000; i++) {
        const result = await window.hsrAutomation.call('simulate_build', { characterId: '1212b1' })
        if (!result.ok) throw Error(JSON.stringify(result))
        if (i % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      }
    })
    report.soak = { calls: 2000, elapsedMs: performance.now() - start, before: startMemory, after: await memory() }
    const idleBefore = await memory()
    await new Promise((resolve) => setTimeout(resolve, 5000))
    report.idle = { durationMs: 5000, before: idleBefore, after: await memory() }
  }
  report.pageErrors = pageErrors
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
} finally {
  await checkpoint()
  await browser.close()
  await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))
}
process.stdout.write(
  JSON.stringify({ searches: report.search.length, inventories: report.inventory.length, workflows: report.workflows, errors: report.errors }, null, 2) + '\n',
)
