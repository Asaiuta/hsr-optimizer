import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  readFile,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { preview } from 'vite'
import type { HsrOptimizerSaveFormat } from '../src/types/store.ts'

const exec = promisify(execFile)
const output = 'output/performance-suite'
const report: Record<string, any> = { storage: [], processes: [], buildOperations: [], mcp: [], errors: [], consoleErrors: [] }
const source = JSON.parse(await readFile('src/data/sample-save.json', 'utf8')) as HsrOptimizerSaveFormat
const character = source.characters.find((entry) => entry.id === '1212b1')!
const server = await preview({ configFile: 'vite.config.ts', preview: { port: 4175, strictPort: true, open: false } })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const browserCdp = await browser.newBrowserCDPSession()
const page = await browser.newPage()
page.on('console', (message) => {
  if (message.type() === 'error') report.consoleErrors.push(message.text())
})
const cdp = await page.context().newCDPSession(page)
await cdp.send('Performance.enable')
async function heap() {
  const data = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(
    data.metrics.filter((entry) => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'JSEventListeners', 'TaskDuration'].includes(entry.name)).map((
      entry,
    ) => [entry.name, entry.value]),
  )
}
async function processes(label: string) {
  const data = await browserCdp.send('SystemInfo.getProcessInfo')
  const processIds = data.processInfo.map((entry) => entry.id)
  const os = await exec('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-Process -Id ${
      processIds.join(',')
    } -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress`,
  ], { windowsHide: true })
  const entry = { label, roles: data.processInfo, memory: JSON.parse(os.stdout), heap: await heap() }
  report.processes.push(entry)
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
  await page.goto('http://127.0.0.1:4175/hsr-optimizer/')
  await page.waitForFunction(() => !!window.hsrAutomation)
  await call('import_save', { json: JSON.stringify(source) })
  await processes('sample-imported')
  for (const count of [1000, 5000, 10000]) {
    const save = {
      ...source,
      characters: [{ ...character, builds: [] }],
      relics: Array.from({ length: count }, (_, i) => ({
        ...source.relics[i % source.relics.length],
        id: i < source.relics.length ? source.relics[i].id : `big-${i}`,
        equippedBy: undefined,
      })),
    }
    const result = await call('import_save', { json: JSON.stringify(save) })
    const persisted = await page.evaluate(() => {
      const text = localStorage.getItem('state')
      return { bytesUtf8: new TextEncoder().encode(text ?? '').length, relics: text ? JSON.parse(text).relics.length : 0 }
    })
    report.storage.push({ count, ms: result.ms, persisted, persistedMatches: persisted.relics === count })
    await processes(`inventory-${count}`)
  }
  await call('import_save', { json: JSON.stringify(source) })
  await cdp.send('HeapProfiler.collectGarbage')
  await processes('sample-restored-after-forced-gc')
  for (let round = 0; round < 3; round++) {
    const before = await heap()
    const start = performance.now()
    await page.evaluate(async () => {
      for (let i = 0; i < 2000; i++) {
        const result = await window.hsrAutomation.call('simulate_build', { characterId: '1212b1' })
        if (!result.ok) throw Error(JSON.stringify(result))
      }
    })
    const elapsedMs = performance.now() - start
    const beforeGc = await heap()
    await cdp.send('HeapProfiler.collectGarbage')
    report.processes.push({ label: `soak-${round}`, calls: 2000, elapsedMs, before, beforeGc, afterForcedGc: await heap() })
  }
  for (let i = 0; i < 10; i++) {
    const name = `Performance ${i}`
    const saved = await call('save_build', { characterId: character.id, name })
    const checked = await call('check_builds', { assignments: [{ characterId: character.id, name }] })
    const equipped = await call('equip_builds', { assignments: [{ characterId: character.id, name }], expectedRevision: checked.data.inventoryRevision })
    const removed = await call('delete_build', { characterId: character.id, name })
    report.buildOperations.push({ saveMs: saved.ms, checkMs: checked.ms, equipMs: equipped.ms, deleteMs: removed.ms })
  }
  // CPU profile is a separate diagnostic run, excluded from preceding wall-clock samples.
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.start')
  await page.evaluate(async () => {
    for (let i = 0; i < 1000; i++) await window.hsrAutomation.call('simulate_build', { characterId: '1212b1' })
  })
  const profile = await cdp.send('Profiler.stop')
  await writeFile(`${output}/current-renderer.cpuprofile`, JSON.stringify(profile.profile))
} catch (error) {
  report.errors.push(String(error))
  process.exitCode = 1
} finally {
  await browser.close()
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['scripts/automation-mcp.mts'],
  cwd: resolve('.'),
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    HSR_AUTOMATION_URL: 'http://127.0.0.1:4175/hsr-optimizer/',
  },
  stderr: 'pipe',
})
const client = new Client({ name: 'performance-measurement', version: '1.0.0' })
try {
  let start = performance.now()
  await client.connect(transport)
  report.mcpConnectMs = performance.now() - start
  start = performance.now()
  const tools = await client.listTools()
  report.mcpDiscoveryMs = performance.now() - start
  report.mcpToolCount = tools.tools.length
  for (
    const [name, args] of [
      ['hsr_import_save_file', { path: resolve('src/data/sample-save.json') }],
      ['hsr_get_scanner', {}],
      ...Array.from({ length: 20 }, () => ['hsr_simulate_build', { characterId: '1212b1' }]),
    ] as [string, Record<string, unknown>][]
  ) {
    start = performance.now()
    const response = await client.callTool({ name, arguments: args })
    const ms = performance.now() - start
    assert.ok(!response.isError, JSON.stringify(response))
    report.mcp.push({ name, ms, responseBytes: Buffer.byteLength(JSON.stringify(response)) })
  }
} catch (error) {
  report.errors.push(String(error))
  process.exitCode = 1
} finally {
  await client.close()
  await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))
  report.notes = [
    'OS memory is per process; shared pages must not be naively summed.',
    'Forced GC is diagnostic retained-heap measurement, not normal operating memory.',
    'Scanner status measured without launching capture/UAC or requiring a game account.',
  ]
  await writeFile(`${output}/integration-report.json`, JSON.stringify(report, null, 2))
}
