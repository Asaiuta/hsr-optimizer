import type { StatsValues } from 'lib/constants/constants'
import type {
  RelicsByPart,
  SingleRelicByPart,
} from 'lib/gpu/webgpuTypes'
import { BasicStatToKey } from 'lib/optimization/basicStatsArray'
import { calculateRelicMainStatValue } from 'lib/relics/relicUtils'
import { precisionRound } from 'lib/utils/mathUtils'
import { isFlat } from 'lib/utils/statUtils'
import type { Form } from 'types/form'
import type { Relic } from 'types/relic'

export const splitRelicsByPart = (relics: Relic[]) => {
  const result: RelicsByPart = {
    Head: [],
    Hands: [],
    Body: [],
    Feet: [],
    PlanarSphere: [],
    LinkRope: [],
  }
  for (const relic of relics) {
    result[relic.part].push(relic)
  }
  return result
}

export const mergePreviewSubstats = (request: Form, relics: Relic[]) => {
  const upgradeLevel = request.mainStatUpscaleLevel
  relics.forEach((relic) => {
    relic.previewSubstats.forEach((s, idx) => {
      if (relic.enhance + 3 * idx < upgradeLevel) {
        relic.substats.push(s)
      }
    })
  })
}

export const applyMainStatsFilter = (request: Form, relics: Relic[]) => {
  const mainStatUpscaleLevel = request.mainStatUpscaleLevel
  if (mainStatUpscaleLevel) {
    relics.forEach((x) => {
      const { grade, enhance, main: { stat } } = x
      const maxEnhance = grade * 3
      if (enhance < maxEnhance && enhance < mainStatUpscaleLevel) {
        const newEnhance = maxEnhance < mainStatUpscaleLevel ? maxEnhance : mainStatUpscaleLevel
        const newValue = calculateRelicMainStatValue(stat, grade, newEnhance) / (isFlat(x.main.stat) ? 1 : 100)
        x.augmentedStats!.mainValue = newValue
      }
    })
  }
  return relics
}

export const condenseRelicSubstatsForOptimizerSingle = (relics: Relic[]) => {
  for (const relic of relics) {
    relic.condensedStats = []
    for (const substat of relic.substats) {
      const stat = substat.stat
      const key = BasicStatToKey[stat]
      const value = getValueByStatType(stat, substat.value)

      relic.condensedStats.push([key, value])
    }
    // Use augmented main value for maxed main stat filter
    relic.condensedStats.push([BasicStatToKey[relic.augmentedStats!.mainStat as StatsValues], relic.augmentedStats!.mainValue])
  }
}

export const condenseRelicSubstatsForOptimizer = (relicsByPart: RelicsByPart) => {
  for (const relics of Object.values(relicsByPart)) {
    condenseRelicSubstatsForOptimizerSingle(relics)
  }

  return relicsByPart
}

export const condenseSingleRelicByPartSubstatsForOptimizer = (singleRelicByPart: Partial<SingleRelicByPart>) => {
  for (const relic of Object.values(singleRelicByPart)) {
    condenseRelicSubstatsForOptimizerSingle([relic])
  }

  return singleRelicByPart
}

function getValueByStatType(stat: string, value: number) {
  return precisionRound(isFlat(stat) ? value : value / 100)
}
