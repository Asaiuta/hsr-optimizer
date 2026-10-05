import {
  AutomationError,
  type simulationSchema,
} from 'lib/automation/contracts'
import {
  requireBuild,
  requireCharacter,
  resolveRequest,
} from 'lib/automation/core/request'
import { Constants } from 'lib/constants/constants'
import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { formatOptimizerDisplayData } from 'lib/optimization/optimizerDisplayData'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import {
  applyMainStatsFilter,
  condenseRelicSubstatsForOptimizer,
  mergePreviewSubstats,
  splitRelicsByPart,
} from 'lib/relics/relicPreparation'
import {
  OrnamentSetToIndex,
  RelicSetToIndex,
} from 'lib/sets/setConfigRegistry'
import { simulateBuild } from 'lib/simulations/simulateBuild'
import type { SimulationRelicByPart } from 'lib/simulations/statSimulationTypes'
import type { Character } from 'types/character'
import type { Relic } from 'types/relic'
import type { z } from 'zod'

export function numericStats(row: OptimizerDisplayData): Record<string, number> {
  const output: Record<string, number> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'number') continue
    if (!Number.isFinite(value)) throw new AutomationError('INVALID_RESULT', `Non-finite ${key} in simulation output`)
    output[key] = value
  }
  return output
}

export function existingRelics(
  characters: readonly Character[],
  inventory: Readonly<Record<string, Relic | undefined>>,
  characterId: string,
  ids?: string[],
  buildName?: string,
) {
  const equipment = buildName ? requireBuild(characters, characterId, buildName).equipped : requireCharacter(characters, characterId).equipped
  ids ??= Object.values(equipment).filter((id): id is string => !!id)
  if (ids.length !== 6 || new Set(ids).size !== 6) throw new AutomationError('INVALID_INPUT', 'Exactly six distinct relics are required')
  const relics = ids.map((id) => {
    const relic = inventory[id]
    if (!relic) throw new AutomationError('NOT_FOUND', `Relic ${id} is unavailable`)
    return relic
  })
  if (new Set(relics.map((relic) => relic.part)).size !== 6) throw new AutomationError('INVALID_INPUT', 'Provide one relic for each slot')
  return relics
}

export function validateRelicSlot(relic: Pick<Relic, 'part' | 'set'>, mainStat: string) {
  const allowed: readonly string[] = Constants.PartsMainStats[relic.part]
  const sets = relic.part === 'PlanarSphere' || relic.part === 'LinkRope' ? OrnamentSetToIndex : RelicSetToIndex
  if (!allowed.includes(mainStat) || !Object.hasOwn(sets, relic.set)) throw new AutomationError('INVALID_INPUT', `Invalid main stat or set for ${relic.part}`)
}

export function simulate(input: z.infer<typeof simulationSchema>, characters: readonly Character[], inventory: Readonly<Record<string, Relic | undefined>>) {
  const { form } = resolveRequest(input, characters)
  const relics = input.virtualRelics
    ? input.virtualRelics.map((spec) => {
      validateRelicSlot(spec, spec.mainStat)
      if (
        spec.enhance > spec.grade * 3 || new Set(spec.substats.map((stat) => stat.stat)).size !== spec.substats.length
        || spec.substats.some((stat) => stat.stat === spec.mainStat)
      ) throw new AutomationError('INVALID_INPUT', 'Invalid upgrade level or substats')
      return RelicAugmenter.augment({ ...structuredClone(spec), id: `virtual:${spec.part}`, main: { stat: spec.mainStat, value: 0 } })!
    })
    : structuredClone(existingRelics(characters, inventory, input.characterId, input.relicIds, input.buildName))
  if (new Set(relics.map((relic) => relic.part)).size !== 6) throw new AutomationError('INVALID_INPUT', 'Provide one relic for each slot')
  mergePreviewSubstats(form, relics)
  applyMainStatsFilter(form, relics)
  const grouped = splitRelicsByPart(relics)
  condenseRelicSubstatsForOptimizer(grouped)
  const build: SimulationRelicByPart = {
    Head: grouped.Head[0],
    Hands: grouped.Hands[0],
    Body: grouped.Body[0],
    Feet: grouped.Feet[0],
    PlanarSphere: grouped.PlanarSphere[0],
    LinkRope: grouped.LinkRope[0],
  }
  const context = generateContext(form)
  const result = simulateBuild(build, context, null)
  return {
    characterId: input.characterId,
    virtual: !!input.virtualRelics,
    relicIds: relics.map((relic) => relic.id),
    stats: numericStats(formatOptimizerDisplayData(result.x, context)),
    rotation: result.rotationDamage,
  }
}

export function compare(
  baseline: z.infer<typeof simulationSchema>,
  candidates: z.infer<typeof simulationSchema>[],
  characters: readonly Character[],
  inventory: Readonly<Record<string, Relic | undefined>>,
) {
  if (candidates.some((candidate) => candidate.characterId !== baseline.characterId)) {
    throw new AutomationError('INVALID_INPUT', 'A build comparison must use the same character')
  }
  const base = simulate(baseline, characters, inventory)
  return {
    baseline: base,
    candidates: candidates.map((candidate) => {
      const result = simulate(candidate, characters, inventory)
      const changes = Object.fromEntries(
        Object.entries(result.stats).filter(([key, value]) => key !== 'id' && value !== base.stats[key])
          .map((
            [key, value],
          ) => [key, {
            before: base.stats[key],
            after: value,
            delta: value - base.stats[key],
            percent: base.stats[key] ? (value / base.stats[key] - 1) * 100 : null,
          }]),
      )
      return { ...result, changes }
    }),
  }
}
