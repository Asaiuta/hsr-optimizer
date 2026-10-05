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
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'
import type { HsrOptimizerSaveFormat } from '../src/types/store.ts'

const exec = promisify(execFile)
const directory = resolve('output/headless-benchmark')
const savePath = resolve('src/data/sample-save.json')
const binary = resolve('output/headless/automation-headless.mjs')
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const options = { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
const coldRepetitions = 6 // Each of five characters: 30 fresh processes per command.
const warmRepetitions = 5

await build({ configFile: 'vite.headless.config.ts', configLoader: 'native' })
await build({
  configFile: 'vite.headless.config.ts',
  configLoader: 'native',
  build: {
    outDir: directory,
    rollupOptions: { input: resolve('scripts/benchmark-headless-worker.ts'), output: { entryFileNames: 'worker.mjs' } },
  },
})
await mkdir(directory, { recursive: true })
const saveBytes = await readFile(savePath)
const save = JSON.parse(saveBytes.toString()) as HsrOptimizerSaveFormat
const characters = save.characters.filter((character) => Object.values(character.equipped).filter(Boolean).length === 6)
assert.equal(characters.length, 5, 'Revisit workload if the sample save changes')
const requests = characters.map(({ id: characterId }) => ({
  baseline: { characterId },
  candidates: [
    { characterId, settings: { rotation: ['DEFAULT_SKILL', 'DEFAULT_ULT'] } },
    { characterId, settings: { mainStatUpscaleLevel: 15 } },
    { characterId, settings: { teammates: [{ characterId: characterId === '1212b1' ? '1005b1' : '1212b1' }, null, null] } },
    { characterId },
  ],
}))
const requestsPath = resolve(directory, 'requests.json')
await writeFile(requestsPath, JSON.stringify(requests, null, 2))
const preload = resolve(directory, 'peak-rss.mjs')
await writeFile(preload, `process.on('exit', () => process.stderr.write(JSON.stringify({peakRssBytes: process.resourceUsage().maxRSS * 1024}) + '\\n'))`)
for (const [index, request] of requests.entries()) {
  await writeFile(resolve(directory, `simulate-${index}.json`), JSON.stringify(request.baseline))
  await writeFile(resolve(directory, `compare-${index}.json`), JSON.stringify(request))
}
type ColdSample = { command: string, characterId: string, wallMs: number, executionMs: number, processUptimeMs: number, rssBytes: number, peakRssBytes: number }
const cold: ColdSample[] = []
const expectedHashes = new Map<string, string>()
for (let repetition = 0; repetition < coldRepetitions; repetition++) {
  // Alternate ordering to reduce systematic ordering bias; never run workers concurrently.
  for (const index of Array.from(requests.keys()).slice(repetition % 2).concat(Array.from(requests.keys()).slice(0, repetition % 2))) {
    for (const command of repetition % 2 ? ['compare_builds', 'simulate_build'] : ['simulate_build', 'compare_builds']) {
      const requestPath = resolve(directory, `${command === 'simulate_build' ? 'simulate' : 'compare'}-${index}.json`)
      const started = performance.now()
      const result = await exec(process.execPath, ['--import', pathToFileURL(preload).href, binary, command, savePath, requestPath], options)
      const wallMs = performance.now() - started
      assert.equal(JSON.parse(result.stdout).ok, true)
      const key = `${command}:${index}`
      const outputHash = hash(result.stdout)
      if (expectedHashes.has(key)) assert.equal(outputHash, expectedHashes.get(key), 'Output changed between runs')
      else expectedHashes.set(key, outputHash)
      const metrics = Object.assign({}, ...result.stderr.trim().split(/\r?\n/).map((line) => JSON.parse(line))) as Omit<
        ColdSample,
        'command' | 'characterId' | 'wallMs'
      >
      cold.push({ command, characterId: characters[index].id, wallMs, ...metrics })
    }
  }
  process.stderr.write(`Cold runs: ${(repetition + 1) * characters.length * 2}/${coldRepetitions * characters.length * 2}\n`)
}
type WarmResult = {
  command: string,
  samplesMs: number[],
  rounds: number,
  warmupRounds: number,
  requestsPerRound: number,
  simulationsPerRound: number,
  cpuMs: number,
  rssBeforeBytes: number,
  rssAfterBytes: number,
}
const warm: { metadataMs: number, saveMs: number, peakRssBytes: number, results: WarmResult[] }[] = []
for (let i = 0; i < warmRepetitions; i++) {
  const result = await exec(process.execPath, [resolve(directory, 'worker.mjs'), savePath, requestsPath], options)
  warm.push(JSON.parse(result.stdout))
  process.stderr.write(`Warm workers: ${i + 1}/${warmRepetitions}\n`)
}
function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b)
  const count = sorted.length
  return {
    count,
    min: sorted[0],
    median: count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2,
    p95: sorted[Math.ceil(count * 0.95) - 1],
    max: sorted[count - 1],
  }
}
const summary = ['simulate_build', 'compare_builds'].map((command) => {
  const fresh = cold.filter((sample) => sample.command === command)
  const hot = warm.flatMap((worker) => worker.results.filter((sample) => sample.command === command))
  const elapsedMs = hot.reduce((sum, entry) => sum + entry.samplesMs.reduce((sum, value) => sum + value, 0), 0)
  return {
    command,
    coldWallMs: distribution(fresh.map((sample) => sample.wallMs)),
    coldExecutionMs: distribution(fresh.map((sample) => sample.executionMs)),
    coldPeakMiB: distribution(fresh.map((sample) => sample.peakRssBytes / 1024 ** 2)),
    warmMsPerRequest: distribution(hot.flatMap((entry) => entry.samplesMs.map((value) => value / entry.requestsPerRound))),
    warmRequestsPerSecond: hot.reduce((sum, entry) => sum + entry.rounds * entry.requestsPerRound, 0) / elapsedMs * 1000,
    warmSimulationsPerSecond: hot.reduce((sum, entry) => sum + entry.rounds * entry.simulationsPerRound, 0) / elapsedMs * 1000,
  }
})
const report = {
  timestamp: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  source: {
    head: (await exec('git', ['rev-parse', 'HEAD'], options)).stdout.trim(),
    status: (await exec('git', ['status', '--short'], options)).stdout,
    bundleSha256: hash(await readFile(binary)),
    workerSha256: hash(await readFile(resolve(directory, 'worker.mjs'))),
    saveSha256: hash(saveBytes),
    requestsSha256: hash(await readFile(requestsPath)),
  },
  workload: {
    characters: characters.map((character) => character.id),
    relicCount: save.relics.length,
    saveBytes: saveBytes.length,
    coldRepetitions,
    warmRepetitions,
    compareSimulationsPerRequest: 5,
    outputHashes: Object.fromEntries(expectedHashes),
  },
  notes: [
    'Fresh processes with OS filesystem cache uncontrolled; not a cold disk benchmark.',
    'Cold wall time includes process launch, input parsing, inventory setup, JSON output and shutdown, plus a peak RSS preload.',
    'Warm samples time five sequential requests; exclude setup, input validation and JSON serialization. No forced GC.',
    'maxRSS is the OS high-water resident working set, not private bytes or managed heap.',
    'Warm worker is a benchmark harness, not a persistent production API. No browser or relic-search comparison.',
  ],
  summary,
  warmPeakMiB: distribution(warm.map((worker) => worker.peakRssBytes / 1024 ** 2)),
  cold,
  warm,
}
await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2))
process.stdout.write(JSON.stringify({ summary, warmPeakMiB: report.warmPeakMiB, report: resolve(directory, 'report.json') }, null, 2) + '\n')
