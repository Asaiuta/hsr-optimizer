// @vitest-environment jsdom
import sample from 'data/sample-save.json'
import i18next from 'i18next'
import { executeCommand } from 'lib/automation/api'
import { resolveRequest } from 'lib/automation/request'
import { COMPUTE_ENGINE_GPU_STABLE } from 'lib/constants/constants'
import { SavedSessionKeys } from 'lib/constants/constantsSession'
import { getWebgpuDevice } from 'lib/gpu/webgpuDevice'
import { gpuOptimize } from 'lib/gpu/webgpuOptimizer'
import { webgpuCrashNotification } from 'lib/interactions/notifications'
import { Optimizer } from 'lib/optimization/optimizer'
import { Metadata } from 'lib/state/metadataInitializer'
import { useGlobalStore } from 'lib/stores/app/appStore'
import {
  finishOptimizationRun,
  useOptimizerDisplayStore,
} from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { OptimizerTabController } from 'lib/tabs/tabOptimizer/optimizerTabController'
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest'

vi.mock('lib/gpu/webgpuDevice', () => ({ getWebgpuDevice: vi.fn() }))
vi.mock('lib/gpu/webgpuOptimizer', () => ({ gpuOptimize: vi.fn() }))
vi.mock('lib/interactions/notifications', () => ({ webgpuCrashNotification: vi.fn() }))
vi.mock('lib/worker/workerPool', () => ({ workerPool: { cancelQueue: vi.fn() }, WorkerCancelledError: class extends Error {} }))

const character = sample.characters.find((entry) => entry.id === '1212b1')!
const ids = new Set(Object.values(character.equipped))
const json = JSON.stringify({ characters: [character], relics: sample.relics.filter((entry) => ids.has(entry.id)) })
const input = {
  characterId: character.id,
  settings: {
    keepCurrentRelics: true,
    rankFilter: false,
    enhance: 0,
    mainBody: [],
    mainFeet: [],
    mainPlanarSphere: [],
    mainLinkRope: [],
    setFilters: { fourPiece: [], twoPieceCombos: [], ornaments: [] },
  },
}
const device = {} as GPUDevice
const state = useOptimizerDisplayStore.getState

function start(runId = 'startup') {
  useOptimizerDisplayStore.setState({ optimizationId: runId, optimizationInProgress: true, optimizationOutcome: null })
  return Optimizer.optimize({ ...resolveRequest(input).form, optimizationId: runId })
}

beforeEach(async () => {
  vi.useFakeTimers()
  await i18next.init({ lng: 'en', resources: {} })
  Metadata.initialize()
  useOptimizerDisplayStore.setState(useOptimizerDisplayStore.getInitialState())
  expect(executeCommand('import_save', { json }).ok).toBe(true)
  useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, COMPUTE_ENGINE_GPU_STABLE)
  vi.mocked(getWebgpuDevice).mockResolvedValue(device)
  vi.spyOn(OptimizerTabController, 'setTopRow')
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

it('yields before GPU preparation and finishes the equipped row before a fast search can complete', async () => {
  vi.mocked(gpuOptimize).mockImplementation(async ({ request }) => {
    expect(OptimizerTabController.setTopRow).toHaveBeenCalledTimes(1)
    expect(state().optimizerSelectedRowData).not.toBeNull()
    finishOptimizationRun(request.optimizationId, { status: 'completed' })
  })
  const pending = start()
  expect(getWebgpuDevice).not.toHaveBeenCalled()
  expect(OptimizerTabController.setTopRow).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(gpuOptimize).toHaveBeenCalledTimes(1)
  await pending
  expect(state().optimizationOutcome).toEqual({ status: 'completed' })

  // A selection made after completion must not be overwritten by a delayed equipped row.
  state().setOptimizerSelectedRowData(null)
  await vi.advanceTimersByTimeAsync(1000)
  expect(OptimizerTabController.setTopRow).toHaveBeenCalledTimes(1)
  expect(state().optimizerSelectedRowData).toBeNull()
})

it('does not prepare or dispatch a run cancelled during the startup yield', async () => {
  const pending = start()
  Optimizer.cancel()
  await vi.advanceTimersByTimeAsync(0)
  await pending
  expect(getWebgpuDevice).not.toHaveBeenCalled()
  expect(OptimizerTabController.setTopRow).not.toHaveBeenCalled()
  expect(gpuOptimize).not.toHaveBeenCalled()
  expect(state().optimizationOutcome).toEqual({ status: 'cancelled' })
})

it('does not dispatch a run cancelled while acquiring its device', async () => {
  const acquiring = Promise.withResolvers<GPUDevice>()
  vi.mocked(getWebgpuDevice).mockReturnValue(acquiring.promise)
  const pending = start()
  await vi.advanceTimersByTimeAsync(0)
  expect(getWebgpuDevice).toHaveBeenCalledTimes(1)
  Optimizer.cancel()
  acquiring.resolve(device)
  await pending
  expect(gpuOptimize).not.toHaveBeenCalled()
  expect(state().optimizationOutcome).toEqual({ status: 'cancelled' })
})

it('ignores an old device acquisition failure after a newer search completes', async () => {
  const acquiring = Promise.withResolvers<GPUDevice>()
  vi.mocked(getWebgpuDevice).mockReturnValueOnce(acquiring.promise)
  const oldRun = start('old')
  await vi.advanceTimersByTimeAsync(0)
  Optimizer.cancel()
  vi.mocked(gpuOptimize).mockImplementation(async ({ request }) => finishOptimizationRun(request.optimizationId, { status: 'completed' }))
  const newRun = start('new')
  await vi.advanceTimersByTimeAsync(0)
  await newRun
  const selection = state().optimizerSelectedRowData
  acquiring.reject(new Error('Old device failed'))
  await oldRun
  await vi.advanceTimersByTimeAsync(1000)
  expect(gpuOptimize).toHaveBeenCalledTimes(1)
  expect(state().optimizationId).toBe('new')
  expect(state().optimizationOutcome).toEqual({ status: 'completed' })
  expect(state().optimizerSelectedRowData).toBe(selection)
  expect(webgpuCrashNotification).not.toHaveBeenCalled()
})

it('reports an unavailable GPU as a failure with the equipped row still prepared', async () => {
  vi.mocked(getWebgpuDevice).mockResolvedValue(undefined)
  const pending = start()
  await vi.advanceTimersByTimeAsync(0)
  await pending
  expect(state().optimizationOutcome).toEqual({ status: 'failed', error: 'GPU acceleration is unavailable' })
  expect(OptimizerTabController.setTopRow).toHaveBeenCalledTimes(1)
  expect(gpuOptimize).not.toHaveBeenCalled()
})

it('publishes GPU failures without leaving an active run', async () => {
  vi.mocked(gpuOptimize).mockRejectedValue(new Error('Compilation failed'))
  const pending = start()
  await vi.advanceTimersByTimeAsync(0)
  await pending
  expect(state().optimizationOutcome).toEqual({ status: 'failed', error: 'Compilation failed' })
  expect(state().optimizationInProgress).toBe(false)
  expect(webgpuCrashNotification).toHaveBeenCalledTimes(1)
})
