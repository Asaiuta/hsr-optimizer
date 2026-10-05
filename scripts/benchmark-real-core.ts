import { resolveRequest } from 'lib/automation/core/request'
import { parseSave } from 'lib/automation/core/save'
import { simulate } from 'lib/automation/core/simulation'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import { scoreRelicsBatch } from 'lib/relics/scoreRelicsBatch'
import { prepareScoringMetadata } from 'lib/relics/scoring/scoringMetadata'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { Metadata } from 'lib/state/metadataInitializer'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
} from 'node:fs'
import type { CharacterId } from 'types/character'

const [input, output] = process.argv.slice(2)
assert.ok(input && output)
const source = readFileSync(input, 'utf8')
const report: Record<string, any> = {
  node: process.version,
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  phases: [],
  simulations: [],
  scoring: [],
}
const start = performance.now()
Metadata.initialize()
report.metadataMs = performance.now() - start
function measure<T>(name: string, rounds: number, fn: () => T) {
  fn()
  const times = []
  let value: T | undefined
  for (let i = 0; i < rounds; i++) {
    const start = performance.now()
    value = fn()
    times.push(performance.now() - start)
  }
  const row = { name, samplesMs: times, medianMs: times.toSorted((a, b) => a - b)[Math.floor(rounds / 2)] }
  report.phases.push(row)
  return value!
}
const save = measure('parse-save', 11, () => parseSave(source))
const augmented = measure('clone-and-augment-relics', 5, () => structuredClone(save.relics).map((r) => RelicAugmenter.augment(r)!))
const inventory = Object.fromEntries(augmented.map((r) => [r.id, r]))
const successful: CharacterId[] = []
for (const c of save.characters) {
  const metadata = getGameMetadata().characters[c.id as CharacterId]
  if (!c.form.lightCone || Object.values(c.equipped).filter(Boolean).length !== 6) {
    report.simulations.push({ characterId: c.id, name: metadata?.name, skipped: 'Missing light cone or incomplete relics' })
    continue
  }
  const request = { characterId: c.id }
  try {
    const baseline = simulate(request, save.characters, inventory)
    const result = measure(`simulate/${c.id}`, 31, () => simulate(request, save.characters, inventory))
    assert.deepEqual(result, baseline)
    report.simulations.push({ characterId: c.id, name: metadata?.name, result, timing: report.phases.at(-1) })
    successful.push(c.id as CharacterId)
    if (['1512', '1501', '1415', '1407', '1310b1', '1308', '1213', '1015'].includes(c.id)) {
      const { form } = measure(`resolve/${c.id}`, 101, () => resolveRequest(request, save.characters))
      const context = measure(`context/${c.id}`, 101, () => generateContext(form))
      measure(`clone-context/${c.id}`, 51, () => JSON.parse(JSON.stringify(context)))
    }
  } catch (error) {
    report.simulations.push({ characterId: c.id, name: metadata?.name, error: String(error) })
  }
}
const scoringMetadata = new Map(successful.map((id) => [id, prepareScoringMetadata(id)]))
for (const count of [1, 8, successful.length]) {
  const ids = successful.slice(0, count)
  const scored = measure(`relic-scoring/${save.relics.length}x${ids.length}`, 3, () => scoreRelicsBatch(save.relics, ids, scoringMetadata, null, [], {}))
  report.scoring.push({ characters: ids.length, relics: scored.length, timing: report.phases.at(-1) })
}
report.peakRssBytes = process.resourceUsage().maxRSS * 1024
report.memory = process.memoryUsage()
writeFileSync(output, JSON.stringify(report, null, 2))
process.stdout.write(JSON.stringify({ successful: successful.length, peakRssBytes: report.peakRssBytes, output }) + '\n')
