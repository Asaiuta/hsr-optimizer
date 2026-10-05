import type { ComputedStatsContainer } from 'lib/optimization/engine/container/computedStatsContainer'
import { formatOptimizerDisplayData } from 'lib/optimization/optimizerDisplayData'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'

export function transformOptimizerDisplayData(x: ComputedStatsContainer, key?: string) {
  const optimizerDisplayData = formatOptimizerDisplayData(x, useOptimizerDisplayStore.getState().context)

  if (key) {
    // For optimizer grid syncing with sim table
    optimizerDisplayData.statSim = {
      key: key,
    }

    // Using the key string for the ID for optimizer grid, since the id does not need to be a permutation index here
    // @ts-expect-error Stat sim rows use string keys as IDs instead of numeric permutation indices
    optimizerDisplayData.id = key
  }

  return optimizerDisplayData
}
