import { saveNamedBuild } from 'lib/automation/builds'
import {
  AutomationError,
  type RequestInput,
} from 'lib/automation/contracts'
import { inventoryRevision } from 'lib/automation/inventory'
import { resolveRequest } from 'lib/automation/request'
import { numericStats } from 'lib/automation/simulation'
import {
  COMPUTE_ENGINE_CPU,
  COMPUTE_ENGINE_GPU_STABLE,
} from 'lib/constants/constants'
import { SavedSessionKeys } from 'lib/constants/constantsSession'
import { Optimizer } from 'lib/optimization/optimizer'
import { useGlobalStore } from 'lib/stores/app/appStore'
import type { OptimizationOutcome } from 'lib/stores/optimizerUI/optimizerUITypes'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { submitOptimization } from 'lib/tabs/tabOptimizer/optimizerForm/optimizerFormActions'
import { OptimizerTabController } from 'lib/tabs/tabOptimizer/optimizerTabController'
import type { Build } from 'types/character'

type Result = { relics: Build, stats: Record<string, number> }
export type Job = {
  id: string,
  revision: number,
  request: ReturnType<typeof resolveRequest>,
  outcome: OptimizationOutcome | null,
  results: Result[],
}
let latest: Job | undefined
let batchRunning = false
export function setBatchRunning(running: boolean) {
  batchRunning = running
}

export function requireIdle() {
  if (batchRunning || useOptimizerDisplayStore.getState().optimizationInProgress) {
    throw new AutomationError('BUSY', 'An optimization or batch is already running')
  }
}

function requireJob(id: string) {
  if (!latest || latest.id !== id) throw new AutomationError('NOT_FOUND', 'Job is unavailable; only the most recent automation job is retained')
  return latest
}

export function startJob(input: RequestInput & { engine: 'cpu' | 'gpu' }) {
  requireIdle()
  const request = resolveRequest(input)
  return getJob(runJob(request, input.engine).id)
}

/** Internal batch entry: the batch owns admission; only one engine run may be active. */
export function runJob(request: ReturnType<typeof resolveRequest>, engine: 'cpu' | 'gpu', settled?: (job: Job) => void): Job {
  if (useOptimizerDisplayStore.getState().optimizationInProgress) throw new AutomationError('BUSY', 'An optimization is already running')
  useGlobalStore.getState().setSavedSessionKey(SavedSessionKeys.computeEngine, engine === 'cpu' ? COMPUTE_ENGINE_CPU : COMPUTE_ENGINE_GPU_STABLE)
  const job: Job = { id: submitOptimization(request.form), revision: inventoryRevision(), request, outcome: null, results: [] }
  latest = job
  const unsubscribe = useOptimizerDisplayStore.subscribe((state) => {
    if (state.optimizationId !== job.id) {
      job.outcome = { status: 'cancelled' }
      unsubscribe()
      settled?.(job)
      return
    }
    if (!state.optimizationOutcome) return
    unsubscribe()
    job.outcome = state.optimizationOutcome
    if (job.outcome.status === 'completed') {
      try {
        job.results = OptimizerTabController.getRows().map((row) => ({
          relics: OptimizerTabController.calculateRelicIdsFromId(row.id, request.form) as Build,
          stats: numericStats(row),
        }))
      } catch (error) {
        job.outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
      }
    }
    settled?.(job)
  })
  return job
}

export function getJob(id: string) {
  const job = requireJob(id)
  const state = useOptimizerDisplayStore.getState()
  const ownsRun = state.optimizationId === id
  return {
    jobId: id,
    status: job.outcome?.status ?? 'running',
    error: job.outcome?.status === 'failed' ? job.outcome.error : undefined,
    progress: ownsRun ? state.optimizerProgress : undefined,
    searched: ownsRun ? state.permutationsSearched : undefined,
    permutations: ownsRun ? state.permutations : undefined,
    resultCount: job.results.length,
    inventoryRevision: job.revision,
    stale: inventoryRevision() !== job.revision,
    characterId: job.request.form.characterId,
    objective: job.request.form.resultSort,
    statDisplay: job.request.form.statDisplay,
  }
}

export function getResults(id: string, offset: number, limit: number) {
  const job = requireJob(id)
  if (job.outcome?.status !== 'completed') throw new AutomationError('NOT_COMPLETED', 'Results require a successfully completed search')
  return { ...getJob(id), offset, results: structuredClone(job.results.slice(offset, offset + limit)) }
}

export function cancelJob(id: string) {
  const job = requireJob(id)
  if (!job.outcome && useOptimizerDisplayStore.getState().optimizationId === id) Optimizer.cancel()
  return getJob(id)
}

export function saveResult(id: string, index: number, name: string) {
  requireIdle()
  const job = requireJob(id)
  if (job.outcome?.status !== 'completed') throw new AutomationError('NOT_COMPLETED', 'Cannot save an incomplete search')
  if (inventoryRevision() !== job.revision) throw new AutomationError('STALE_INVENTORY', 'Inventory changed; run the search again before saving')
  const result = job.results[index]
  if (!result) throw new AutomationError('NOT_FOUND', 'Result index is out of range')
  const saved = saveNamedBuild(job.request, name, result.relics)
  // Saving a result changes only the named-build list; the search inputs still match.
  job.revision = inventoryRevision()
  return saved
}
