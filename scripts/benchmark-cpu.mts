import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  readFile,
  writeFile,
} from 'node:fs/promises'
import {
  cpus,
  totalmem,
} from 'node:os'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { preview } from 'vite'

const root = resolve(process.argv[3] ?? 'output/performance-cpu-topk-20261004')
const group = process.argv[2]
assert.ok(['before-1', 'after-1', 'after-2', 'before-2'].includes(group))
const variant = group.split('-')[0]
const protocol = JSON.parse(await readFile(`${root}/protocol.json`, 'utf8'))
const report: Record<string, any> = {
  group,
  timestamp: new Date().toISOString(),
  environment: { cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version },
  tasks: [],
  errors: [],
}
await writeFile(`${root}/${group}.json`, JSON.stringify(report, null, 2), { flag: 'wx' })
const checkpoint = () => writeFile(`${root}/${group}.json`, JSON.stringify(report, null, 2))
const server = await preview({
  configFile: 'vite.config.ts',
  build: { outDir: `${root}/${variant}/site` },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true, open: false },
})
try {
  for (const spec of protocol.cases) {
    const browser = await chromium.launch({ channel: 'msedge', headless: true })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.addInitScript(() => {
        const counters = {
          messages: 0,
          sentBytes: 0,
          receivedBytes: 0,
          maximumReceivedBytes: 0,
          maximumCandidates: 0,
          dispatched: 0,
          sendMs: 0,
          slimRelicTasks: 0,
          typedBitsetTasks: 0,
        }
        Object.assign(window, { __cpuTraffic: counters })
        const Original = window.Worker
        window.Worker = class extends Original {
          optimizerTask = false
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options)
            this.addEventListener('message', (e) => {
              if (!this.optimizerTask || e.data?.type === 'WORKER_READY') return
              const bytes = e.data.candidates?.byteLength ?? e.data.buffer?.byteLength ?? 0
              counters.messages++
              counters.receivedBytes += bytes
              counters.maximumReceivedBytes = Math.max(counters.maximumReceivedBytes, bytes)
              counters.maximumCandidates = Math.max(counters.maximumCandidates, (e.data.candidates?.length ?? 0) / 2)
              this.optimizerTask = false
            })
          }
          override postMessage(message: any, transfer: Transferable[] | StructuredSerializeOptions = []) {
            this.optimizerTask = message.workerType === 0
            if (this.optimizerTask) {
              counters.sentBytes += message.buffer?.byteLength ?? 0
              counters.dispatched++
              if (Object.keys(message.relics.Head[0]).length === 3) counters.slimRelicTasks++
              if (message.relicSetSolutions instanceof Uint32Array && message.ornamentSetSolutions instanceof Uint32Array) counters.typedBitsetTasks++
            }
            const start = performance.now()
            if (Array.isArray(transfer)) super.postMessage(message, transfer)
            else super.postMessage(message, transfer)
            if (this.optimizerTask) counters.sendMs += performance.now() - start
          }
        }
      })
      await page.goto('http://127.0.0.1:4175/hsr-optimizer/')
      await page.waitForFunction(() => !!(window as any).__cpuBenchmark)
      const input = await readFile(resolve(spec.input), 'utf8')
      assert.equal(createHash('sha256').update(input).digest('hex'), spec.sha256)
      const imported = await page.evaluate((json) => window.hsrAutomation.call('import_save', { json }), input)
      assert.ok(imported.ok, JSON.stringify(imported))
      const settings = await page.evaluate(({ id, settings }) => (window as any).__cpuBenchmark.inspect(id, settings), {
        id: spec.characterId,
        settings: spec.settings,
      })
      for (let iteration = 0; iteration < protocol.iterations; iteration++) {
        const task = await page.evaluate(async ({ spec, iteration }) => {
          const counters = (window as any).__cpuTraffic
          for (const key of Object.keys(counters)) counters[key] = 0
          const startedAt = performance.now()
          const job = (window as any).__cpuBenchmark.start(spec.characterId, spec.settings)
          let status: any
          do {
            await new Promise((r) => setTimeout(r, 10))
            const reply = await window.hsrAutomation.call('get_job', { jobId: job.jobId })
            if (!reply.ok) throw Error(JSON.stringify(reply))
            status = reply.data
            if (performance.now() - startedAt > 120000) {
              await window.hsrAutomation.call('cancel_job', { jobId: job.jobId })
              throw Error('120-second observation budget exhausted')
            }
          } while (status.status === 'running')
          return { case: spec.name, iteration, jobId: job.jobId, status, elapsedMs: performance.now() - startedAt, traffic: { ...counters } }
        }, { spec, iteration }) as any
        task.settings = settings
        task.inputSha256 = spec.sha256
        report.tasks.push(task)
        await checkpoint()
        assert.equal(task.status.status, 'completed')
        assert.equal(task.status.permutations, spec.permutations)
        assert.equal(task.status.resultCount, spec.settings.resultsLimit)
        task.results = []
        for (let offset = 0; offset < task.status.resultCount; offset += 100) {
          const reply = await page.evaluate(({ jobId, offset }) => window.hsrAutomation.call('get_results', { jobId, offset, limit: 100 }), {
            jobId: task.jobId,
            offset,
          }) as any
          assert.ok(reply.ok, JSON.stringify(reply))
          task.results.push(...reply.data.results)
        }
        assert.equal(new Set(task.results.map((r: any) => Object.values(r.relics).sort().join('/'))).size, task.status.resultCount)
        task.verification = await page.evaluate(async ({ spec, results }) => {
          let maximum = 0
          let fields = 0
          for (const row of results) {
            const reply = await window.hsrAutomation.call('simulate_build', {
              characterId: spec.characterId,
              relicIds: Object.values(row.relics),
              settings: { ...spec.settings, resultsLimit: 100 },
            }) as any
            if (!reply.ok) throw Error(JSON.stringify(reply))
            for (const [key, value] of Object.entries(reply.data.stats)) {
              if (key === 'id' || key === 'WEIGHT') continue
              if (!Object.hasOwn(reply.data.stats, 'mHP') && key.startsWith('m')) continue
              const error = Math.abs(row.stats[key] - (value as number)) / Math.max(1, Math.abs(value as number))
              if (!Number.isFinite(error) || error >= 1e-5) throw Error(`Recomputation mismatch: ${key}/${error}`)
              maximum = Math.max(maximum, error)
              fields++
            }
          }
          return { rows: results.length, fields, maximumRelativeError: maximum }
        }, { spec, results: task.results })
        assert.deepEqual(errors, [])
        await checkpoint()
        process.stdout.write(
          `${spec.name} #${iteration}: ${task.elapsedMs.toFixed(1)}ms, received=${task.traffic.receivedBytes}, verified=${task.verification.rows}\n`,
        )
      }
    } finally {
      await browser.close()
    }
  }
} catch (error) {
  report.errors.push(String(error))
  process.exitCode = 1
  process.stderr.write(String(error) + '\n')
} finally {
  await checkpoint()
  await new Promise<void>((r, reject) => server.httpServer.close((e) => e ? reject(e) : r()))
}
