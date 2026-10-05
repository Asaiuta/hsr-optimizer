import { isCpuFilterDisabled } from 'lib/optimization/cpuFilterBounds'
import { SortOption } from 'lib/optimization/sortOptions'
import type { Form } from 'types/form'
import type { OptimizerContext } from 'types/optimizer'

type CpuActionPlan = {
  defaultActionCount: number,
  rotationActionCount: number,
}

/** Plan execution only; preserve the complete context and its original register indices. */
export function getCpuActionPlan(request: Form, context: OptimizerContext): CpuActionPlan {
  const full = { defaultActionCount: context.defaultActions.length, rotationActionCount: context.rotationActions.length }
  const option = SortOption[request.resultSort!]
  if (request.trace || !option) return full

  if (option.globalRegisterIndex != null) {
    // These totals are accumulated entirely in the preceding rotation loop.
    // Defaults can still supply filters and COMBO_BUFF, so retain them there.
    const rotationTotal = option.key === 'COMBO' || option.key === 'COMBO_HEAL' || option.key === 'COMBO_SHIELD'
    const filtersDisabled = Object.values(SortOption).every((filter) => {
      if (!filter.minFilterKey || !filter.maxFilterKey) return true
      const min = request[filter.minFilterKey as keyof Form]
      const max = request[filter.maxFilterKey as keyof Form]
      // Loaded forms can omit both bounds. Both comparisons against undefined
      // are false; a single missing bound still leaves the other comparison active.
      return isCpuFilterDisabled(min, max)
    })
    return rotationTotal && full.rotationActionCount > 0 && filtersDisabled
      ? { defaultActionCount: 0, rotationActionCount: full.rotationActionCount }
      : full
  }

  // Default actions have their own precomputed state. Their hits do not consume
  // rotation outputs. CPU keeps its original rotation-before-default execution order.
  const defaults = { ...full, rotationActionCount: 0 }
  if (!option.isComputedRating || option.statKey != null) return defaults

  let lastIndex = context.defaultActions.findIndex((action) => action.actionName === option.key)
  if (lastIndex < 0) return full

  for (const filter of Object.values(SortOption)) {
    if (!filter.minFilterKey || !filter.maxFilterKey) continue
    const min = request[filter.minFilterKey as keyof Form]
    const max = request[filter.maxFilterKey as keyof Form]
    // Match CPU filter activation, including negative and one-sided bounds.
    if (isCpuFilterDisabled(min, max)) continue
    if (filter.statKey != null || (!filter.isComputedRating && request.statDisplay === 'combat')) {
      return defaults
    }
    lastIndex = Math.max(lastIndex, context.defaultActions.findIndex((action) => action.actionName === filter.key))
  }

  // Retain the prefix and every hit within it, including heal-tally dependencies.
  return { defaultActionCount: lastIndex + 1, rotationActionCount: 0 }
}
