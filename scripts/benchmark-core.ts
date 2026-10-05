import { allocate } from 'lib/automation/allocation'
import { commandSchemas } from 'lib/automation/contracts'
import { resolveRequest } from 'lib/automation/core/request'
import { parseSave } from 'lib/automation/core/save'
import { simulate } from 'lib/automation/core/simulation'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { formatOptimizerDisplayData } from 'lib/optimization/optimizerDisplayData'
import { scoreTbp } from 'lib/relics/estTbp/estTbp'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import {
  applyMainStatsFilter,
  condenseRelicSubstatsForOptimizer,
  mergePreviewSubstats,
  splitRelicsByPart,
} from 'lib/relics/relicPreparation'
import { scoreRelicsBatch } from 'lib/relics/scoreRelicsBatch'
import { prepareScoringMetadata } from 'lib/relics/scoring/scoringMetadata'
import { initializeContextConditionals } from 'lib/simulations/contextConditionals'
import { simulateBuild } from 'lib/simulations/simulateBuild'
import type { SimulationRelicByPart } from 'lib/simulations/statSimulationTypes'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { Metadata } from 'lib/state/metadataInitializer'
import { clone } from 'lib/utils/objectUtils'
import assert from 'node:assert/strict'
import {
  readFileSync,
  writeFileSync,
} from 'node:fs'
import type { CharacterId } from 'types/character'
import type { Relic } from 'types/relic'

const output = 'output/performance-suite/core-report.json'
const records: {
  name: string,
  rounds: number,
  samplesMs: number[],
  medianMs: number,
  meanMs: number,
  beforeHeap: number,
  afterHeap: number,
  summary?: unknown,
}[] = []
function measure<T>(name: string, rounds: number, operation: () => T): T {
  operation()
  const beforeHeap = process.memoryUsage().heapUsed
  const samplesMs = []
  let result: T | undefined
  for (let i = 0; i < rounds; i++) {
    const started = performance.now()
    result = operation()
    samplesMs.push(performance.now() - started)
  }
  const sorted = samplesMs.toSorted((a, b) => a - b)
  const medianMs = sorted[Math.floor(sorted.length / 2)]
  records.push({
    name,
    rounds,
    samplesMs,
    medianMs,
    meanMs: samplesMs.reduce((a, b) => a + b, 0) / rounds,
    beforeHeap,
    afterHeap: process.memoryUsage().heapUsed,
  })
  writeFileSync(output, JSON.stringify({ node: process.version, peakRssBytes: process.resourceUsage().maxRSS * 1024, records }, null, 2))
  process.stderr.write(`${name}: ${medianMs.toFixed(3)} ms\n`)
  return result!
}

const start = performance.now()
Metadata.initialize()
const metadataMs = performance.now() - start
process.stderr.write(`Metadata initialization: ${metadataMs.toFixed(3)} ms\n`)
const source = readFileSync('src/data/sample-save.json', 'utf8')
const save = parseSave(source)
const character = save.characters.find((entry) => entry.id === '1212b1')!
const relics = Object.fromEntries(save.relics.map((relic) => [relic.id, RelicAugmenter.augment(relic)!]))
for (const count of [162, 1000, 5000, 10000]) {
  const inventory = Array.from({ length: count }, (_, i) => ({ ...save.relics[i % save.relics.length], id: `synthetic-${i}` }))
  const json = JSON.stringify({ ...save, relics: inventory })
  measure(`parseSave/${count}`, 11, () => parseSave(json))
  const parsed = JSON.parse(json).relics as Relic[]
  measure(`cloneAndAugment/${count}`, 5, () => structuredClone(parsed).map((entry) => RelicAugmenter.augment(entry)))
}
const request = { characterId: character.id }
measure('schema/simulate', 501, () => commandSchemas.simulate_build.parse(request))
measure('clone/characterForm', 501, () => structuredClone(character.form))
const { form } = measure('resolveRequest', 201, () => resolveRequest(request, save.characters))
const context = measure('generateContext', 201, () => generateContext(form))
measure('clone/context-json', 101, () => clone(context))
const serializedContext = clone(context)
measure('clone/context-structured', 101, () => structuredClone(serializedContext))
measure('cloneAndRebuild/context', 101, () => initializeContextConditionals(structuredClone(serializedContext)))
const selected = Object.values(character.equipped).map((id) => relics[id!])
const grouped = measure('prepareSixRelics', 201, () => {
  const selectedCopy = structuredClone(selected)
  mergePreviewSubstats(form, selectedCopy)
  applyMainStatsFilter(form, selectedCopy)
  return condenseRelicSubstatsForOptimizer(splitRelicsByPart(selectedCopy))
})
const build: SimulationRelicByPart = {
  Head: grouped.Head[0],
  Hands: grouped.Hands[0],
  Body: grouped.Body[0],
  Feet: grouped.Feet[0],
  PlanarSphere: grouped.PlanarSphere[0],
  LinkRope: grouped.LinkRope[0],
}
const result = measure('simulateBuild/context-prepared', 501, () => simulateBuild(build, context, null))
const traced = measure('simulateBuild/trace', 101, () => simulateBuild(build, context, null, null, true))
assert.deepEqual(result.rotationDamage, traced.rotationDamage)
measure('formatOptimizerDisplayData', 501, () => formatOptimizerDisplayData(result.x, context))
const complete = measure('simulate/end-to-end-core', 201, () => simulate(request, save.characters, relics))
assert.deepEqual(complete.rotation, result.rotationDamage)
measure('JSON.stringify/simulation', 501, () => JSON.stringify(complete))

const characterIds = Object.keys(getGameMetadata().characters) as CharacterId[]
const metadata = new Map(characterIds.map((id) => [id, prepareScoringMetadata(id)]))
for (const [relicCount, characterCount] of [[162, 1], [162, 5], [162, 108], [1000, 5], [1000, 108], [5000, 5]]) {
  const inventory = Array.from({ length: relicCount }, (_, i) => ({ ...save.relics[i % save.relics.length], id: `score-${i}` }))
  const scored = measure(
    `relicScoring/${relicCount}x${characterCount}`,
    3,
    () => scoreRelicsBatch(inventory, characterIds.slice(0, characterCount), metadata, null, [], {}),
  )
  assert.equal(scored.length, relicCount)
}
const weights = metadata.get(character.id as CharacterId)!.stats
for (const relic of selected) {
  const days = measure(`farmingProbability/${relic.part}`, 5, () => scoreTbp(relic, weights))
  assert.ok(!Number.isNaN(days))
}
for (const groupsCount of [4, 8, 16, 32]) {
  for (const conflict of [false, true]) {
    const groups = Array.from(
      { length: groupsCount },
      (_, group) => ({
        weight: 1,
        candidates: Array.from(
          { length: 20 },
          (_, index) => ({ value: 100 - index, relicIds: Array.from({ length: 6 }, (_, part) => `${conflict ? index % 4 : group}-${part}`) }),
        ),
      }),
    )
    const allocation = measure(`allocate/${groupsCount}x20/conflict=${conflict}`, 5, () => allocate(groups, 100000))
    assert.ok(allocation.nodes <= 100000)
    records.at(-1)!.summary = allocation
    if (allocation.indices) {
      const used = allocation.indices.flatMap((index, group) => groups[group].candidates[index].relicIds)
      assert.equal(new Set(used).size, used.length)
    }
  }
}
writeFileSync(
  output,
  JSON.stringify(
    {
      node: process.version,
      metadataMs,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      contextSerializedBytes: Buffer.byteLength(JSON.stringify(serializedContext)),
      records,
      notes: [
        'One warmup per phase; serial runs; timings are inclusive of the named operation.',
        'cloneAndAugment includes cloning; cloneAndRebuild includes structured cloning.',
        'Synthetic relic scoring repeats stat patterns with unique IDs; not all inventory diversity represented.',
        'Phase times from separate loops cannot be summed as an end-to-end trace.',
      ],
    },
    null,
    2,
  ),
)
