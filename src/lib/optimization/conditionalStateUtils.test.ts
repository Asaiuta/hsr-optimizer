import { ConditionalActivation } from 'lib/constants/constants'
import { evaluateConditional, type DynamicConditional } from 'lib/gpu/conditionals/dynamicConditionals'
import { resetConditionalState } from 'lib/optimization/conditionalStateUtils'
import type { ComputedStatsContainer } from 'lib/optimization/engine/container/computedStatsContainer'
import type { OptimizerAction, OptimizerContext } from 'types/optimizer'
import { expect, it } from 'vitest'

it('rearms SINGLE conditions once per action across repeated resets', () => {
  const action = {} as OptimizerAction
  let calls = 0
  const conditional: DynamicConditional = { id: 'single', type: 0, activation: ConditionalActivation.SINGLE,
    dependsOn: [], chainsTo: [], condition: () => true, effect: () => { calls++ }, gpu: () => '',
  }
  for (let i = 0; i < 4; i++) {
    resetConditionalState(action)
    for (let j = 0; j < 3; j++) evaluateConditional(conditional, {} as ComputedStatsContainer, action, {} as OptimizerContext)
    expect(calls).toBe(i + 1)
  }
})

it('preserves within-action accumulated state and clears late supplemental state between actions', () => {
  const action = { conditionalState: { conversion: NaN, supplemental: Infinity } } as unknown as OptimizerAction
  const observed: number[][] = []
  const conditional: DynamicConditional = { id: 'conversion', type: 0, activation: ConditionalActivation.CONTINUOUS,
    dependsOn: [], chainsTo: [], condition: () => true,
    effect: (_x, a) => {
      const previous = a.conditionalState.conversion ?? 0
      const supplemental = a.conditionalState.supplemental || 0
      observed.push([previous, supplemental])
      a.conditionalState.conversion = previous + 0.5
      a.conditionalState.supplemental = supplemental + 2
    }, gpu: () => '',
  }
  for (let i = 0; i < 3; i++) {
    resetConditionalState(action)
    for (let j = 0; j < 2; j++) evaluateConditional(conditional, {} as ComputedStatsContainer, action, {} as OptimizerContext)
    action.conditionalState.addedLater = -4
    resetConditionalState(action)
    expect(action.conditionalState.addedLater ?? 0).toBe(0)
  }
  expect(observed).toEqual([[0, 0], [0.5, 2], [0, 0], [0.5, 2], [0, 0], [0.5, 2]])
})
