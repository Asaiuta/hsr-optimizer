import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
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
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { preview } from 'vite'
import type { HsrOptimizerSaveFormat } from '../src/types/store.ts'

const [savePath, outputPath] = process.argv.slice(2)
assert.ok(savePath && outputPath, 'Usage: node scripts/benchmark-real.mts SAVE.json OUTPUT_DIRECTORY')
const output = resolve(outputPath)
await mkdir(output, { recursive: true })
const sourceText = await readFile(savePath, 'utf8')
const source = JSON.parse(sourceText) as HsrOptimizerSaveFormat
const relics = new Map(source.relics.map((relic) => [relic.id, relic]))
const parts = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope'] as const
const selectedIds = ['1512', '1501', '1415', '1407', '1310b1', '1308', '1213', '1015']
const plans = []
for (const id of selectedIds) {
  const character = source.characters.find((entry) => entry.id === id)
  if (!character?.form.lightCone) continue
  const equipped = parts.map((part) => relics.get(character.equipped[part]!))
  if (equipped.some((relic) => !relic)) continue
  const gear = equipped.map((relic) => relic!)
  // These scenarios retain the currently equipped 4pc/2pc sets and main stats.
  if (!gear.slice(0, 4).every((r) => r.set === gear[0].set) || gear[4].set !== gear[5].set) continue
  for (const enhance of id === '1512' || id === '1407' ? [15, 0] : [15]) {
    const counts = gear.map((current) =>
      source.relics.filter((r) =>
        r.part === current.part && r.set === current.set && r.main.stat === current.main.stat && r.grade === 5 && r.enhance >= enhance
      ).length
    )
    plans.push({
      name: `${id}/enhance-${enhance}`,
      characterId: id,
      slotCounts: Object.fromEntries(parts.map((part, i) => [part, counts[i]])),
      upperBound: counts.reduce((a, b) => a * b, 1),
      settings: {
        grade: 5,
        enhance,
        rankFilter: false,
        includeEquippedRelics: true,
        keepCurrentRelics: false,
        mainBody: [gear[2].main.stat],
        mainFeet: [gear[3].main.stat],
        mainPlanarSphere: [gear[4].main.stat],
        mainLinkRope: [gear[5].main.stat],
        setFilters: { fourPiece: [gear[0].set], twoPieceCombos: [], ornaments: [gear[4].set] },
        resultsLimit: 10,
        resultSort: 'COMBO',
      },
    })
  }
}
assert.ok(plans.length, 'No fully equipped scenario characters found')
const report: Record<string, any> = {
  timestamp: new Date().toISOString(),
  sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
  distHtmlSha256: createHash('sha256').update(await readFile('dist/index.html')).digest('hex'),
  environment: { node: process.version, cpu: cpus()[0].model, logicalCpus: cpus().length, memoryBytes: totalmem() },
  counts: { characters: source.characters.length, relics: source.relics.length, fullyEnhanced: source.relics.filter((r) => r.enhance === 15).length },
  plans,
  inventory: [],
  simulations: [],
  search: [],
  checks: [],
  processes: [],
  soak: [],
  mcp: [],
  errors: [],
  pageErrors: [],
  notes: [
    'Real inventory, no synthetic relics. Current 4pc/2pc sets and current main stats; settings are saved per scenario.',
    'Production build without Worker/GPU API wrappers. CDP heap/process snapshots taken outside timed regions.',
    'Search completion polled in the page every 10ms, bounded at 120s per task. Three sequential samples, not a reliable P95.',
    'Source scan supplies gear but not actual combat rotation/teammates. Imported defaults remain in effect.',
    'All-character simulation uses existing equipped gear, skipping missing cone or incomplete gear. No equipping or saving builds.',
  ],
}
async function checkpoint() {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2))
}
await checkpoint()
const server = await preview({ configFile: 'vite.config.ts', preview: { port: 4175, strictPort: true, open: false } })
const launch = performance.now()
const browser = await chromium.launch({ channel: 'msedge', headless: true })
report.browserLaunchMs = performance.now() - launch
const page = await browser.newPage()
const cdp = await page.context().newCDPSession(page)
const browserCdp = await browser.newBrowserCDPSession()
await cdp.send('Performance.enable')
page.on('pageerror', (error) => report.pageErrors.push(error.message))
async function memory() {
  const data = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(
    data.metrics.filter((m) => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'JSEventListeners', 'TaskDuration'].includes(m.name))
      .map((m) => [m.name, m.value]),
  )
}
async function snapshot(label: string) {
  const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo')
  const result = await promisify(execFile)('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-Process -Id ${
      processInfo.map((p) => p.id).join(',')
    } -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress`,
  ], { windowsHide: true })
  report.processes.push({ label, roles: processInfo, processes: JSON.parse(result.stdout), heap: await memory() })
}
async function call(name: string, input: unknown = {}) {
  return page.evaluate(async ({ name, input }) => {
    const start = performance.now()
    const response = await window.hsrAutomation.call(name, input)
    if (!response.ok) throw Error(JSON.stringify(response))
    return { ms: performance.now() - start, data: response.data as any }
  }, { name, input })
}
try {
  const nav = performance.now()
  await page.goto('http://127.0.0.1:4175/hsr-optimizer/')
  await page.waitForFunction(() => !!window.hsrAutomation)
  report.navigationMs = performance.now() - nav
  report.gpu = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter()
    return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null
  })
  for (let i = 0; i < 3; i++) {
    const imported = await call('import_save', { json: sourceText })
    assert.equal(imported.data.relics, source.relics.length)
    const exported = await call('export_save')
    const parsed = JSON.parse(exported.data)
    assert.equal(parsed.relics.length, source.relics.length)
    const diff = await call('compare_inventory', { json: exported.data })
    assert.equal(diff.data.total, 0)
    const listed = await call('list_relics', { offset: Math.max(0, source.relics.length - 100), limit: 100 })
    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem('state')
      const saved = raw ? JSON.parse(raw) : null
      return { bytes: new TextEncoder().encode(raw ?? '').length, relics: saved?.relics.length ?? 0, characters: saved?.characters.length ?? 0 }
    })
    report.inventory.push({
      i,
      importMs: imported.ms,
      exportMs: exported.ms,
      diffMs: diff.ms,
      lastPageMs: listed.ms,
      exportedBytes: Buffer.byteLength(exported.data),
      persisted,
      persistedMatches: persisted.relics === source.relics.length && persisted.characters === source.characters.length,
    })
  }
  await snapshot('after-import')
  for (const character of source.characters) {
    if (!character.form.lightCone || Object.values(character.equipped).filter(Boolean).length !== 6) {
      report.simulations.push({ characterId: character.id, skipped: 'Missing light cone or incomplete relics' })
      continue
    }
    const result = await page.evaluate(async (characterId) => {
      const samples = []
      let baseline: string | undefined
      for (let i = 0; i < 12; i++) {
        const start = performance.now()
        const result = await window.hsrAutomation.call('simulate_build', { characterId })
        const ms = performance.now() - start
        if (!result.ok) return { error: result.error }
        const output = JSON.stringify(result.data)
        if (baseline !== undefined && output !== baseline) throw Error(`Unstable simulation ${characterId}`)
        baseline = output
        samples.push(ms)
      }
      return { firstMs: samples[0], samplesMs: samples.slice(1), result: JSON.parse(baseline!) }
    }, character.id)
    report.simulations.push({ characterId: character.id, ...result })
    await checkpoint()
  }
  for (const plan of plans) {
    const simulation = report.simulations.find((entry: any) => entry.characterId === plan.characterId)
    if (!simulation?.result) {
      report.search.push({ name: plan.name, skipped: simulation?.error ?? simulation?.skipped ?? 'No valid equipped simulation' })
      continue
    }
    report.resolvedRequests ??= {}
    report.resolvedRequests[plan.name] = (await call('get_request', { characterId: plan.characterId, settings: plan.settings })).data
    if (!plan.upperBound || plan.upperBound > 20000000) {
      report.search.push({ name: plan.name, skipped: 'Empty or greater than 20M upper bound' })
      continue
    }
    for (const engine of report.gpu ? ['cpu', 'gpu'] : ['cpu']) {
      for (let iteration = 0; iteration < 3; iteration++) {
        const result = await page.evaluate(async ({ characterId, settings, engine }) => {
          const start = performance.now()
          const submitted = await window.hsrAutomation.call('start_optimization', { characterId, settings, engine }) as any
          if (!submitted.ok) throw Error(JSON.stringify(submitted))
          const submitMs = performance.now() - start
          const jobId = submitted.data.jobId
          let status: any
          do {
            await new Promise((resolve) => setTimeout(resolve, 10))
            status = await window.hsrAutomation.call('get_job', { jobId }) as any
            if (!status.ok) throw Error(JSON.stringify(status))
            if (performance.now() - start > 120000) {
              await window.hsrAutomation.call('cancel_job', { jobId })
              return { timedOut: true, status: status.data, elapsedMs: performance.now() - start }
            }
          } while (status.data.status === 'running')
          const elapsedMs = performance.now() - start
          if (status.data.status !== 'completed') return { elapsedMs, status: status.data }
          const rows = await window.hsrAutomation.call('get_results', { jobId, limit: 10 }) as any
          if (!rows.ok) throw Error(JSON.stringify(rows))
          const verified = []
          for (const row of rows.data.results) {
            const sim = await window.hsrAutomation.call('simulate_build', { characterId, settings, relicIds: Object.values(row.relics) }) as any
            if (!sim.ok) throw Error(JSON.stringify(sim))
            const error = Math.abs(sim.data.stats.COMBO - row.stats.COMBO) / Math.max(1, Math.abs(sim.data.stats.COMBO))
            if (error >= 1e-5) throw Error(`Result score mismatch: ${error}`)
            verified.push(error)
          }
          return { submitMs, elapsedMs, status: status.data, results: rows.data.results, verified }
        }, { characterId: plan.characterId, settings: plan.settings, engine })
        report.search.push({ name: plan.name, engine, iteration, ...result, memory: await memory() })
        await checkpoint()
        process.stderr.write(`${plan.name} ${engine} #${iteration}: ${result.elapsedMs.toFixed(1)}ms ${result.status.status} ${result.status.permutations}\n`)
        if (result.status.status !== 'completed') break
      }
    }
  }
  for (const cpu of report.search.filter((r: any) => r.engine === 'cpu' && r.results)) {
    const gpu = report.search.find((r: any) => r.engine === 'gpu' && r.name === cpu.name && r.iteration === cpu.iteration && r.results)
    if (!gpu) continue
    const scores = (r: any) => r.results.map((row: any) => row.stats.COMBO as number).sort((a: number, b: number) => b - a)
    const a = scores(cpu), b = scores(gpu)
    const error = a.length === b.length ? Math.max(0, ...a.map((score: number, i: number) => Math.abs(score - b[i]) / Math.max(1, Math.abs(score)))) : null
    report.checks.push({ name: cpu.name, iteration: cpu.iteration, count: a.length, maxRelativeError: error, passed: error !== null && error < 1e-5 })
  }
  await snapshot('after-search')
  const successfulIds = report.simulations.filter((s: any) => s.result).map((s: any) => s.characterId)
  assert.ok(successfulIds.length)
  for (let round = 0; round < 3; round++) {
    const before = await memory()
    const result = await page.evaluate(async (ids) => {
      const start = performance.now()
      for (let i = 0; i < 1000; i++) {
        const result = await window.hsrAutomation.call('simulate_build', { characterId: ids[i % ids.length] })
        if (!result.ok) throw Error(JSON.stringify(result))
        if (i % 100 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      }
      return { calls: 1000, elapsedMs: performance.now() - start }
    }, successfulIds)
    const after = await memory()
    await cdp.send('HeapProfiler.collectGarbage')
    report.soak.push({ round, ...result, before, after, afterGc: await memory() })
    await checkpoint()
  }
  const idleBefore = await memory()
  await new Promise((resolve) => setTimeout(resolve, 5000))
  report.idle = { durationMs: 5000, before: idleBefore, after: await memory() }
  await snapshot('after-soak')
} catch (error) {
  report.errors.push(String(error))
  process.exitCode = 1
} finally {
  await checkpoint()
  await browser.close()
}
// A separate stdio session measures complete MCP transport without model/tool orchestration latency.
const client = new Client({ name: 'real-account-benchmark', version: '1.0.0' })
try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/automation-mcp.mts')],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      HSR_AUTOMATION_URL: 'http://127.0.0.1:4175/hsr-optimizer/',
    },
    stderr: 'pipe',
  })
  let start = performance.now()
  await client.connect(transport)
  report.mcpConnectMs = performance.now() - start
  start = performance.now()
  report.mcpTools = (await client.listTools()).tools.length
  report.mcpDiscoveryMs = performance.now() - start
  start = performance.now()
  const imported = await client.callTool({ name: 'hsr_import_save_file', arguments: { path: resolve(savePath) } })
  report.mcpImportMs = performance.now() - start
  assert.ok(!imported.isError)
  for (const characterId of selectedIds.slice(0, 4)) {
    if (!report.simulations.some((s: any) => s.characterId === characterId && s.result)) continue
    for (let iteration = 0; iteration < 11; iteration++) {
      start = performance.now()
      const result = await client.callTool({ name: 'hsr_simulate_build', arguments: { characterId } })
      const ms = performance.now() - start
      assert.ok(!result.isError, JSON.stringify(result))
      report.mcp.push({ characterId, iteration, ms, bytes: Buffer.byteLength(JSON.stringify(result)) })
    }
  }
} catch (error) {
  report.errors.push(String(error))
  process.exitCode = 1
} finally {
  await client.close()
  await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))
  await checkpoint()
}
