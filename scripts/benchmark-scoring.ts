import { resolveRequest } from 'lib/automation/core/request'
import { parseSave } from 'lib/automation/core/save'
import type { PreviewRelics } from 'lib/characterPreview/characterPreviewController'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import {
  executeOrchestrator,
  executeUpgradeOrchestrator,
  prepareOrchestrator,
} from 'lib/simulations/orchestrator/runDpsScoreBenchmarkOrchestrator'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { Metadata } from 'lib/state/metadataInitializer'
import { calculateWarps } from 'lib/tabs/tabWarp/warpCalculatorController'
import {
  DEFAULT_WARP_REQUEST,
  DEFAULT_WARP_TARGET,
} from 'lib/tabs/tabWarp/warpCalculatorTypes'
import { runComputeOptimalSimulationInline } from 'lib/worker/computeOptimalSimulationWorkerRunner'
import assert from 'node:assert/strict'
import {
  readFileSync,
  writeFileSync,
} from 'node:fs'
import type { CharacterId } from 'types/character'
import type { Form } from 'types/form'
import { ScoringConfigType } from 'types/metadata'

Metadata.initialize()
const source = parseSave(readFileSync('src/data/sample-save.json', 'utf8'))
const relics = new Map(source.relics.map((entry) => [entry.id, RelicAugmenter.augment(entry)!]))
const results: unknown[] = []
const template = source.characters.find((entry) => entry.id === '1212b1')!
const extraCharacters = (['1402', '1407', '1310'] as CharacterId[]).map((id) => {
  const metadata = getGameMetadata()
  const lightCone = Object.keys(metadata.lightCones).find((cone) =>
    metadata.lightCones[cone as keyof typeof metadata.lightCones].path === metadata.characters[id].path
  )!
  const character = { ...template, id, form: { characterId: id, characterEidolon: 0, lightCone, lightConeSuperimposition: 1 } as Form }
  character.form = resolveRequest({ characterId: id }, [character]).form
  return character
})
for (const character of [...source.characters.filter((entry) => Object.values(entry.equipped).filter(Boolean).length === 6), ...extraCharacters]) {
  const simulation = getGameMetadata().characters[character.id].scoringMetadata.simulation
  if (!simulation) {
    results.push({ id: character.id, skipped: 'No DPS simulation metadata' })
    continue
  }
  const build = Object.fromEntries(Object.entries(character.equipped).map(([part, id]) => [part, relics.get(id!)])) as PreviewRelics
  let expected: number | undefined
  for (let round = 0; round < 3; round++) {
    const start = performance.now()
    const orchestrator = prepareOrchestrator(character, { configType: ScoringConfigType.DPS, simulation }, build, {})
    const prepareMs = performance.now() - start
    const searches: { phase: string, ms: number }[] = []
    const scoreStart = performance.now()
    await executeOrchestrator(orchestrator, {
      searchRunner: async (input, context) => {
        const start = performance.now()
        const result = runComputeOptimalSimulationInline(input)
        searches.push({ phase: context.phase, ms: performance.now() - start })
        return result
      },
    })
    const executeMs = performance.now() - scoreStart
    const upgradeStart = performance.now()
    await executeUpgradeOrchestrator(orchestrator)
    const upgradeMs = performance.now() - upgradeStart
    if (expected !== undefined) assert.equal(orchestrator.percent, expected)
    expected = orchestrator.percent
    results.push({ id: character.id, round, prepareMs, executeMs, upgradeMs, searches, score: expected })
    process.stderr.write(`Scoring ${character.id} #${round}: ${executeMs.toFixed(1)} ms\n`)
    writeFileSync('output/performance-suite/scoring-report.json', JSON.stringify({ results }, null, 2))
  }
}
const warp = []
for (const targets of [1, 4, 8]) {
  const request = { ...DEFAULT_WARP_REQUEST, passes: 300, targets: Array.from({ length: targets }, (_, i) => ({ ...DEFAULT_WARP_TARGET, id: `target-${i}` })) }
  const timings = []
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    calculateWarps(request)
    timings.push(performance.now() - start)
  }
  warp.push({ targets, timings })
}
writeFileSync(
  'output/performance-suite/scoring-report.json',
  JSON.stringify(
    {
      node: process.version,
      results,
      warp,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      notes: ['DPS scoring with inline search runner; excludes Worker transport and UI cache hits.', 'First round is cold; later rounds reuse loaded code.'],
    },
    null,
    2,
  ),
)
