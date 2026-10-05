import type { OptimizerAction } from 'types/optimizer'

/** Missing state values are read as zero; each action starts with fresh state. */
export function resetConditionalState(action: OptimizerAction): void {
  action.conditionalState = {}
}
