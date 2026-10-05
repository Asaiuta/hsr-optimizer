import { commandSchemas } from 'lib/automation/contracts'
import { parseSave } from 'lib/automation/core/save'
import {
  compare,
  simulate,
} from 'lib/automation/core/simulation'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import { Metadata } from 'lib/state/metadataInitializer'
import { useScoringStore } from 'lib/stores/scoring/scoringStore'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const started = performance.now()
Metadata.initialize()
const metadataMs = performance.now() - started
const save = parseSave(readFileSync(process.argv[2], 'utf8'))
useScoringStore.getState().setScoringMetadataOverrides(save.scoringMetadataOverrides ?? {})
const relics = Object.fromEntries(save.relics.map((relic) => {
  const augmented = RelicAugmenter.augment(relic)
  if (!augmented) throw new Error(`Invalid relic ${relic.id}`)
  return [augmented.id, augmented]
}))
const saveMs = performance.now() - started - metadataMs
const requests = commandSchemas.compare_builds.array().parse(JSON.parse(readFileSync(process.argv[3], 'utf8')))
const expected = requests.map(({ baseline, candidates }) => compare(baseline, candidates, save.characters, relics))
const rounds = 100
const warmupRounds = 20
const results = []
for (const command of ['simulate_build', 'compare_builds'] as const) {
  const run = () =>
    requests.map(({ baseline, candidates }) =>
      command === 'simulate_build'
        ? simulate(baseline, save.characters, relics)
        : compare(baseline, candidates, save.characters, relics)
    )
  for (let i = 0; i < warmupRounds; i++) run()
  const cpuStarted = process.cpuUsage()
  const samplesMs = []
  const rssBeforeBytes = process.memoryUsage().rss
  let last: ReturnType<typeof run> = []
  for (let i = 0; i < rounds; i++) {
    const before = performance.now()
    last = run()
    samplesMs.push(performance.now() - before)
  }
  const cpu = process.cpuUsage(cpuStarted)
  assert.deepEqual(last, command === 'simulate_build' ? expected.map((entry) => entry.baseline) : expected)
  results.push({
    command,
    samplesMs,
    rounds,
    warmupRounds,
    requestsPerRound: requests.length,
    simulationsPerRound: command === 'simulate_build' ? requests.length : requests.reduce((sum, entry) => sum + 1 + entry.candidates.length, 0),
    cpuMs: (cpu.user + cpu.system) / 1000,
    rssBeforeBytes,
    rssAfterBytes: process.memoryUsage().rss,
  })
}
process.stdout.write(JSON.stringify({ metadataMs, saveMs, peakRssBytes: process.resourceUsage().maxRSS * 1024, results }) + '\n')
