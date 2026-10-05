import { allocate } from 'lib/automation/allocation'
import { saveNamedBuild } from 'lib/automation/builds'
import {
  AutomationError,
  type commandSchemas,
} from 'lib/automation/contracts'
import { inventoryRevision } from 'lib/automation/inventory'
import {
  cancelJob,
  type Job,
  requireIdle,
  runJob,
  setBatchRunning,
} from 'lib/automation/jobs'
import { resolveRequest } from 'lib/automation/request'
import { SortOption } from 'lib/optimization/sortOptions'
import { uuid } from 'lib/utils/miscUtils'
import type { z } from 'zod'

type Batch = {
  id: string,
  revision: number,
  status: 'running' | 'completed' | 'cancelled' | 'failed',
  error?: string,
  requests: ReturnType<typeof resolveRequest>[],
  jobs: Job[],
}
let latest: Batch | undefined
function requireBatch(id: string) {
  if (!latest || latest.id !== id) throw new AutomationError('NOT_FOUND', 'Only the most recent batch is retained')
  return latest
}
function terminal(batch: Batch, status: Exclude<Batch['status'], 'running'>, error?: string) {
  batch.status = status
  batch.error = error
  setBatchRunning(false)
}

export function startBatch(input: z.infer<typeof commandSchemas.start_batch>) {
  requireIdle()
  const requests = input.requests.map(resolveRequest)
  if (requests.reduce((count, request) => count + (request.form.resultsLimit ?? 10), 0) > 1000) {
    throw new AutomationError('INVALID_INPUT', 'A batch may retain at most 1000 results in total')
  }
  const batch: Batch = { id: uuid(), revision: inventoryRevision(), status: 'running', requests, jobs: [] }
  latest = batch
  setBatchRunning(true)
  function next() {
    if (batch.status !== 'running') return
    if (inventoryRevision() !== batch.revision) {
      terminal(batch, 'failed', 'Inventory changed during batch')
      return
    }
    if (batch.jobs.length === requests.length) {
      terminal(batch, 'completed')
      return
    }
    try {
      const job = runJob(requests[batch.jobs.length], input.engine, (job) => {
        if (batch.status !== 'running') return
        if (job.outcome?.status !== 'completed') {
          terminal(batch, job.outcome?.status === 'cancelled' ? 'cancelled' : 'failed', job.outcome?.status === 'failed' ? job.outcome.error : undefined)
          return
        }
        queueMicrotask(next)
      })
      batch.jobs.push(job)
    } catch (error) {
      terminal(batch, 'failed', error instanceof Error ? error.message : String(error))
    }
  }
  next()
  return getBatch(batch.id)
}

export function getBatch(id: string) {
  const batch = requireBatch(id)
  return {
    batchId: id,
    status: batch.status,
    error: batch.error,
    inventoryRevision: batch.revision,
    stale: inventoryRevision() !== batch.revision,
    scenarios: batch.requests.map((request, index) => ({
      index,
      characterId: request.form.characterId,
      status: batch.jobs[index]?.outcome?.status ?? (batch.jobs[index] ? 'running' : batch.status === 'running' ? 'pending' : 'not_started'),
      resultCount: batch.jobs[index]?.results.length ?? 0,
    })),
  }
}
function completedJob(batch: Batch, index: number) {
  const job = batch.jobs[index]
  if (!job || job.outcome?.status !== 'completed') throw new AutomationError('NOT_COMPLETED', 'Scenario has not completed successfully')
  return job
}
export function batchResults(id: string, index: number, offset: number, limit: number) {
  const batch = requireBatch(id)
  const job = completedJob(batch, index)
  return {
    batchId: id,
    requestIndex: index,
    stale: inventoryRevision() !== batch.revision,
    total: job.results.length,
    offset,
    characterId: job.request.form.characterId,
    objective: job.request.form.resultSort,
    results: structuredClone(job.results.slice(offset, offset + limit)),
  }
}
export function cancelBatch(id: string) {
  const batch = requireBatch(id)
  if (batch.status === 'running') {
    terminal(batch, 'cancelled')
    const active = batch.jobs.at(-1)
    if (active && !active.outcome) cancelJob(active.id)
  }
  return getBatch(id)
}
export function saveBatchResult(id: string, requestIndex: number, index: number, name: string) {
  requireIdle()
  const batch = requireBatch(id)
  if (inventoryRevision() !== batch.revision) throw new AutomationError('STALE_INVENTORY', 'Inventory changed; run the batch again')
  const job = completedJob(batch, requestIndex)
  const result = job.results[index]
  if (!result) throw new AutomationError('NOT_FOUND', 'Result index is out of range')
  const saved = saveNamedBuild(job.request, name, result.relics)
  batch.revision = inventoryRevision()
  for (const job of batch.jobs) job.revision = batch.revision
  return saved
}
export function allocateBatch(input: z.infer<typeof commandSchemas.allocate_batch>) {
  requireIdle()
  const batch = requireBatch(input.batchId)
  if (batch.status !== 'completed') throw new AutomationError('NOT_COMPLETED', 'Allocation requires a completed batch')
  if (inventoryRevision() !== batch.revision) throw new AutomationError('STALE_INVENTORY', 'Inventory changed; run the batch again')
  if (new Set(batch.requests.map((request) => request.form.characterId)).size !== batch.requests.length) {
    throw new AutomationError('INVALID_INPUT', 'Allocation requires one scenario per character')
  }
  if (input.weights && input.weights.length !== batch.requests.length) throw new AutomationError('INVALID_INPUT', 'Provide one weight per scenario')
  const groups = batch.jobs.map((job, index) => {
    const form = job.request.form
    const option = SortOption[form.resultSort!]
    const memo = form.memoDisplay === 'memo'
    const column = form.statDisplay === 'combat'
      ? (memo ? option.memoCombatGridColumn : option.combatGridColumn)
      : (memo ? option.memoBasicGridColumn : option.basicGridColumn)
    const candidates = job.results.map((result) => ({ relicIds: Object.values(result.relics), value: result.stats[column] }))
    if (
      candidates.some((candidate) => !Number.isFinite(candidate.value) || candidate.value < 0)
      || candidates.length && !candidates.some((candidate) => candidate.value > 0)
    ) {
      throw new AutomationError('INVALID_RESULT', 'Allocation requires nonnegative scores with a positive maximum for each character')
    }
    return { candidates, weight: input.weights?.[index] ?? 1 }
  })
  const solution = allocate(groups, input.maxNodes)
  return {
    ...solution,
    inventoryRevision: batch.revision,
    scope: 'retained_candidates',
    assignments: solution.indices?.map((index, requestIndex) => ({
      characterId: batch.requests[requestIndex].form.characterId,
      requestIndex,
      index,
      relicIds: groups[requestIndex].candidates[index].relicIds,
      value: groups[requestIndex].candidates[index].value,
    })) ?? null,
  }
}
