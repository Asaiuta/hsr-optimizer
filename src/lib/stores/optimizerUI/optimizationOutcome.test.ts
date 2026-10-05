// @vitest-environment jsdom
import {
  finishOptimizationRun,
  useOptimizerDisplayStore,
} from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import {
  beforeEach,
  expect,
  it,
} from 'vitest'

beforeEach(() => {
  useOptimizerDisplayStore.setState({ ...useOptimizerDisplayStore.getInitialState(), optimizationId: 'current', optimizationInProgress: true })
})

it('rejects completion callbacks belonging to an earlier run', () => {
  finishOptimizationRun('old', { status: 'completed' })
  expect(useOptimizerDisplayStore.getState().optimizationInProgress).toBe(true)
  expect(useOptimizerDisplayStore.getState().optimizationOutcome).toBeNull()
})

it('cannot turn cancellation or failure into success', () => {
  finishOptimizationRun('current', { status: 'failed', error: 'Worker crashed' })
  finishOptimizationRun('current', { status: 'completed' })
  expect(useOptimizerDisplayStore.getState().optimizationOutcome).toEqual({ status: 'failed', error: 'Worker crashed' })
  expect(useOptimizerDisplayStore.getState().optimizationInProgress).toBe(false)
})
