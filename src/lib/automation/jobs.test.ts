// @vitest-environment jsdom
import sample from 'data/sample-save.json'
import { executeCommand } from 'lib/automation/api'
import {
  getBatch,
  startBatch,
} from 'lib/automation/batches'
import { Metadata } from 'lib/state/metadataInitializer'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import {
  getRelics,
  useRelicStore,
} from 'lib/stores/relic/relicStore'
import {
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest'

const pool = vi.hoisted(() => ({ runTask: vi.fn(), cancelQueue: vi.fn(), getPoolSize: () => 1 }))
vi.mock('lib/worker/workerPool', () => ({ workerPool: pool, WorkerCancelledError: class extends Error {} }))

const character = sample.characters.find((entry) => entry.id === '1212b1')!
const ids = new Set(Object.values(character.equipped))
const json = JSON.stringify({ characters: [character], relics: sample.relics.filter((entry) => ids.has(entry.id)) })
const input = {
  characterId: '1212b1',
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

beforeEach(() => {
  vi.clearAllMocks()
  Metadata.initialize()
  useOptimizerDisplayStore.setState(useOptimizerDisplayStore.getInitialState())
  expect(executeCommand('import_save', { json }).ok).toBe(true)
})

it('reports exhausted worker failures as failed, never a partial completed search', async () => {
  pool.runTask.mockRejectedValue(new Error('Worker retries exhausted'))
  const started = executeCommand('start_optimization', input)
  expect(started.ok).toBe(true)
  await vi.waitFor(() => expect(useOptimizerDisplayStore.getState().optimizationOutcome).toEqual({ status: 'failed', error: 'Worker retries exhausted' }))
  const jobId = useOptimizerDisplayStore.getState().optimizationId!
  expect(executeCommand('get_job', { jobId })).toMatchObject({ ok: true, data: { status: 'failed' } })
  expect(executeCommand('get_results', { jobId })).toMatchObject({ ok: false, error: { code: 'NOT_COMPLETED' } })
})

it('ignores an in-flight worker response arriving after cancellation', async () => {
  let complete!: (value: { candidates: Float64Array }) => void
  pool.runTask.mockImplementation(() =>
    new Promise((resolve) => {
      complete = resolve
    })
  )
  executeCommand('start_optimization', input)
  await vi.waitFor(() => expect(pool.runTask).toHaveBeenCalled())
  const jobId = useOptimizerDisplayStore.getState().optimizationId!
  expect(executeCommand('cancel_job', { jobId })).toMatchObject({ ok: true, data: { status: 'cancelled' } })
  complete({ candidates: new Float64Array() })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(executeCommand('get_job', { jobId })).toMatchObject({ ok: true, data: { status: 'cancelled', resultCount: 0 } })
})

it('stops a batch after a worker failure and releases admission for later operations', async () => {
  pool.runTask.mockRejectedValue(new Error('Worker retries exhausted'))
  const batch = startBatch({ requests: [input, input], engine: 'cpu' })
  await vi.waitFor(() => expect(getBatch(batch.batchId).status).toBe('failed'))
  expect(getBatch(batch.batchId).scenarios.map((scenario) => scenario.status)).toEqual(['failed', 'not_started'])
  expect(pool.runTask).toHaveBeenCalledTimes(1)
  expect(executeCommand('save_build', { characterId: input.characterId, name: 'After failure' }).ok).toBe(true)
})

it('stops subsequent batch searches if the inventory changes during an active search', async () => {
  let complete!: (value: { candidates: Float64Array }) => void
  pool.runTask.mockImplementation(() =>
    new Promise((resolve) => {
      complete = resolve
    })
  )
  const batch = startBatch({ requests: [input, input], engine: 'cpu' })
  await vi.waitFor(() => expect(pool.runTask).toHaveBeenCalled())
  useRelicStore.getState().setRelics([...getRelics()])
  complete({ candidates: new Float64Array() })
  await vi.waitFor(() => expect(getBatch(batch.batchId).status).toBe('failed'))
  expect(getBatch(batch.batchId)).toMatchObject({ stale: true, error: 'Inventory changed during batch' })
  expect(pool.runTask).toHaveBeenCalledTimes(1)
})
