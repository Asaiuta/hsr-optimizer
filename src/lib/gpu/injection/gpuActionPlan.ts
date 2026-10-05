import { Constants } from 'lib/constants/constants'
import {
  SortOption,
  type SortOptionProperties,
} from 'lib/optimization/sortOptions'
import type { Form } from 'types/form'
import type { OptimizerContext } from 'types/optimizer'

export function getFilterBounds(request: Form, option: SortOptionProperties) {
  if (!option.minFilterKey || !option.maxFilterKey) return null
  return {
    hasMin: (request[option.minFilterKey as keyof Form] as number) > 0,
    hasMax: (request[option.maxFilterKey as keyof Form] as number) < Constants.MAX_INT,
  }
}

/** Keep a prefix with original action/register indices; never reorder dependent actions. */
export function getGpuActionCount(request: Form, context: OptimizerContext, debug: boolean): number {
  const total = context.defaultActions.length + context.rotationActions.length
  const option = SortOption[request.resultSort!]
  if (debug || !option || option.globalRegisterIndex != null) return total

  // Display stats and EHP come from the last default action. Rotation outputs are
  // not consumed by these objectives or their filters. Retain full default actions,
  // including hits and conditionals, rather than infer intra-action dependencies.
  if (!option.isComputedRating || option.statKey != null) return context.defaultActions.length

  let lastIndex = context.defaultActions.findIndex((action) => action.actionName === option.key)
  if (lastIndex < 0) return total

  for (const filter of Object.values(SortOption)) {
    const bounds = getFilterBounds(request, filter)
    if (!bounds || (!bounds.hasMin && !bounds.hasMax)) continue
    if (filter.key === 'EHP' || (!filter.isComputedRating && request.statDisplay === 'combat')) {
      lastIndex = context.defaultActions.length - 1
    } else {
      lastIndex = Math.max(lastIndex, context.defaultActions.findIndex((action) => action.actionName === filter.key))
    }
  }
  return lastIndex + 1
}
