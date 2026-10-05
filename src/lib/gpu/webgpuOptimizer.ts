import { type ComputeEngine } from 'lib/constants/constants'
import {
  getGpuResultThreshold,
  type WorkgroupEntry,
  writeGpuTieThreshold,
} from 'lib/gpu/webgpuDataTransform'
import { debugWebgpuOutput } from 'lib/gpu/webgpuDebugger'
import { runGpuDeviceTask } from 'lib/gpu/webgpuDeviceTask'
import {
  type ExecutionPassResult,
  generateExecutionPass,
  initializeGpuPipeline,
  submitGpuDispatch,
} from 'lib/gpu/webgpuInternals'
import {
  type GpuExecutionContext,
  type RelicsByPart,
} from 'lib/gpu/webgpuTypes'
import { Message } from 'lib/interactions/message'
import {
  type BasicStatsArray,
  BasicStatsArrayCore,
} from 'lib/optimization/basicStatsArray'
import { type OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { ComputedStatsContainer } from 'lib/optimization/engine/container/computedStatsContainer'
import { formatOptimizerDisplayData } from 'lib/optimization/optimizerDisplayData'
import { searchBound } from 'lib/optimization/pruning/searchBound'
import { SortOption } from 'lib/optimization/sortOptions'
import { initializeContextConditionals } from 'lib/simulations/contextConditionals'
import { simulateBuild } from 'lib/simulations/simulateBuild'
import { type SimulationRelicByPart } from 'lib/simulations/statSimulationTypes'
import { setSortColumn } from 'lib/stores/gridStore'
import { gridStore } from 'lib/stores/gridStore'
import {
  finishOptimizationRun,
  isOptimizationRunActive,
  useOptimizerDisplayStore,
} from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import { activateZeroResultSuggestionsModal } from 'lib/tabs/tabOptimizer/OptimizerSuggestionsModal'
import { OptimizerTabController } from 'lib/tabs/tabOptimizer/optimizerTabController'
import { type Form } from 'types/form'
import { type OptimizerContext } from 'types/optimizer'

globalThis.WEBGPU_DEBUG = false

export async function gpuOptimize(props: {
  device: GPUDevice | null,
  context: OptimizerContext,
  request: Form,
  relics: RelicsByPart,
  permutations: number,
  validPermutations: number,
  computeEngine: string,
  relicSetSolutions: number[],
  ornamentSetSolutions: number[],
}) {
  const { context, request, relics, permutations, validPermutations, computeEngine, relicSetSolutions, ornamentSetSolutions } = props

  const device = props.device
  if (device == null) {
    console.error('Not supported')
    return
  }

  let execution: GpuExecutionContext | undefined
  let gpuContext: GpuExecutionContext | undefined
  let reusable = false
  try {
    gpuContext = await runGpuDeviceTask(device, async () => {
      // A cancelled run may have waited behind a previous task's compilation/readback.
      if (!isOptimizationRunActive(request.optimizationId)) return
      useOptimizerDisplayStore.getState().setOptimizerStartTime(Date.now())
      useOptimizerDisplayStore.getState().setOptimizerRunningEngine(computeEngine as ComputeEngine)
      execution = await initializeGpuPipeline(
        device,
        relics,
        request,
        context,
        permutations,
        computeEngine,
        relicSetSolutions,
        ornamentSetSolutions,
        globalThis.WEBGPU_DEBUG,
      )

      // Compilation can outlive a cancelled or superseded run.
      if (!isOptimizationRunActive(request.optimizationId)) return

      if (execution.DEBUG) Message.warning('Debug mode is ON', 5)
      await runGpuDispatch(execution)
      return execution
    })
    reusable = !!gpuContext && isOptimizationRunActive(request.optimizationId)
  } finally {
    // Failed/cancelled tasks are discarded; healthy unmapped buffers can be reused.
    execution?.bufferLease.release(reusable)
  }

  // Publish only after this task's GPU errors have been checked and buffers released.
  if (!gpuContext || !isOptimizationRunActive(request.optimizationId)) return
  outputResults(gpuContext)
  useOptimizerDisplayStore.setState({
    permutationsSearched: gpuContext.pruningProgress?.evaluated ?? validPermutations,
    optimizerProgress: 1,
    permutationsResults: gpuContext.resultsQueue.size(),
  })
  finishOptimizationRun(request.optimizationId, { status: 'completed' })
}

export function runGpuDispatch(gpuContext: GpuExecutionContext, onEvaluated?: (offset: number, size: number) => void): Promise<number> {
  if (gpuContext.shieldBound) return runShieldDispatch(gpuContext, onEvaluated)
  if (gpuContext.TUPLE_MODE) return runTupleDispatch(gpuContext)
  return runNaiveDispatch(gpuContext, onEvaluated)
}

export async function runShieldDispatch(gpuContext: GpuExecutionContext, onEvaluated?: (offset: number, size: number) => void): Promise<number> {
  if (!gpuContext.shieldBound) throw new Error('Shield dispatch requires an audited bound')
  const active = () => isOptimizationRunActive(gpuContext.request.optimizationId)
  const stride = gpuContext.BLOCK_SIZE * gpuContext.CYCLES_PER_INVOCATION
  let lastDisplay = 0
  const progress = await searchBound(gpuContext.shieldBound, {
    leafSize: gpuContext.COMPACT_LIMIT,
    isActive: active,
    cutoff: () => ({ value: getGpuResultThreshold(gpuContext), full: gpuContext.resultsQueue.size() >= gpuContext.RESULTS_LIMIT }),
    dispatch: async (offset, size) => {
      let evaluated = 0
      for (let local = 0; local < size && active(); local += stride) {
        const length = Math.min(stride, size - local)
        const pass = generateExecutionPass(gpuContext, offset + local, 0, length)
        evaluated += await resolveNaiveRange(gpuContext, offset + local, length, 0, pass, onEvaluated)
      }
      return evaluated
    },
    onProgress: (progress) => {
      gpuContext.pruningProgress = progress
      const now = performance.now()
      if (!active() || now - lastDisplay < 50) return
      lastDisplay = now
      useOptimizerDisplayStore.setState({
        optimizerEndTime: Date.now(),
        permutationsResults: gpuContext.resultsQueue.size(),
        permutationsSearched: progress.evaluated,
        optimizerProgress: (progress.evaluated + progress.pruned) / gpuContext.permutations,
      })
    },
  })
  gpuContext.cancelled = !active()
  return progress.evaluated
}

export async function runNaiveDispatch(gpuContext: GpuExecutionContext, onEvaluated?: (offset: number, size: number) => void): Promise<number> {
  const permStride = gpuContext.BLOCK_SIZE * gpuContext.CYCLES_PER_INVOCATION
  let permutationsSearched = 0

  // Establish a real top-K floor before submitting large double-buffered batches.
  // A seed no larger than the compact buffer cannot overflow, even if every build passes.
  const seedSize = gpuContext.DEBUG ? 0 : Math.min(gpuContext.permutations, gpuContext.COMPACT_LIMIT)
  if (seedSize > 0) {
    const seed = generateExecutionPass(gpuContext, 0, 0, seedSize)
    permutationsSearched += await resolveNaiveRange(gpuContext, 0, seedSize, 0, seed, onEvaluated)
  }
  if (seedSize === gpuContext.permutations || !isOptimizationRunActive(gpuContext.request.optimizationId)) return permutationsSearched

  const iterations = Math.ceil((gpuContext.permutations - seedSize) / permStride)

  let displayOffset = 0
  const WARMUP_ITERATIONS = 3
  const RATE_DISPLAY_THRESHOLD_MS = 100

  let currentBufferIndex = 0
  let currentPassResult = generateExecutionPass(gpuContext, seedSize, currentBufferIndex)

  for (let iteration = 0; iteration < iterations; iteration++) {
    const offset = seedSize + iteration * permStride
    const maxPermNumber = offset + permStride
    const passResult = currentPassResult

    const hasNext = iteration + 1 < iterations && gpuContext.permutations > maxPermNumber

    const nextBufferIndex = 1 - currentBufferIndex
    let nextPassResult: ExecutionPassResult | undefined
    if (hasNext) {
      nextPassResult = generateExecutionPass(gpuContext, maxPermNumber, nextBufferIndex)
    }

    if (gpuContext.DEBUG) {
      await passResult.gpuReadBuffer.mapAsync(GPUMapMode.READ)
      readBufferMapped(offset, passResult.gpuReadBuffer, gpuContext)
      permutationsSearched += permStride
      passResult.gpuReadBuffer.unmap()
    } else {
      permutationsSearched += await resolveNaiveRange(
        gpuContext,
        offset,
        Math.min(permStride, gpuContext.permutations - offset),
        currentBufferIndex,
        passResult,
        onEvaluated,
      )
    }

    if (iteration === WARMUP_ITERATIONS - 1) {
      if (isOptimizationRunActive(gpuContext.request.optimizationId)) {
        useOptimizerDisplayStore.setState({
          optimizerStartTime: Date.now(),
          optimizerEndTime: null,
        })
      }
      displayOffset = permutationsSearched
    }

    if (hasNext && nextPassResult) {
      currentBufferIndex = nextBufferIndex
      currentPassResult = nextPassResult
    }

    const isWarmingUp = iteration < WARMUP_ITERATIONS
    const displaySearched = permutationsSearched - displayOffset
    const progressSnapshot = Math.min(maxPermNumber, gpuContext.permutations) / gpuContext.permutations
    const storeStartTime = useOptimizerDisplayStore.getState().optimizerStartTime
    setTimeout(() => {
      if (!isOptimizationRunActive(gpuContext.request.optimizationId)) return
      const endTimeToSet = Date.now()
      const msDiff = endTimeToSet - (storeStartTime ?? 0)

      // During warmup or before rate stabilizes, only advance progress bar
      if (isWarmingUp || (msDiff < RATE_DISPLAY_THRESHOLD_MS && displaySearched > 0)) {
        useOptimizerDisplayStore.setState({ optimizerProgress: progressSnapshot })
        return
      }

      useOptimizerDisplayStore.setState({
        optimizerEndTime: endTimeToSet,
        permutationsResults: gpuContext.resultsQueue.size(),
        permutationsSearched: displaySearched,
        optimizerProgress: progressSnapshot,
      })
    }, 0)

    if (!isOptimizationRunActive(gpuContext.request.optimizationId)) {
      gpuContext.cancelled = true
      break
    }
  }

  return permutationsSearched
}

async function resolveNaiveRange(
  gpuContext: GpuExecutionContext,
  offset: number,
  size: number,
  bufferIndex: number,
  passResult: ExecutionPassResult,
  onEvaluated?: (offset: number, size: number) => void,
): Promise<number> {
  const buffer = passResult.compactReadBuffer
  await buffer.mapAsync(GPUMapMode.READ)
  let overflow: boolean
  try {
    if (!isOptimizationRunActive(gpuContext.request.optimizationId)) return 0
    const mappedRange = buffer.getMappedRange()
    const count = new Uint32Array(mappedRange, 0, 1)[0]
    overflow = count > gpuContext.COMPACT_LIMIT
    if (!overflow) {
      processCompactResults(offset, count, mappedRange, gpuContext)
      onEvaluated?.(offset, size)
      return new Uint32Array(mappedRange, 4 + gpuContext.compactResultsBufferSize, 1)[0]
    }
  } finally {
    buffer.unmap()
  }

  // Discard incomplete output. Disjoint children are each admitted only once, so
  // no duplicate-index set is needed. At size <= COMPACT_LIMIT overflow is impossible.
  if (size <= gpuContext.COMPACT_LIMIT) throw new Error('GPU result count exceeded the dispatched range')
  const leftSize = Math.floor(size / 2)
  const leftPass = generateExecutionPass(gpuContext, offset, bufferIndex, leftSize)
  const leftCount = await resolveNaiveRange(gpuContext, offset, leftSize, bufferIndex, leftPass, onEvaluated)
  if (!isOptimizationRunActive(gpuContext.request.optimizationId)) return leftCount
  const rightSize = size - leftSize
  const rightPass = generateExecutionPass(gpuContext, offset + leftSize, bufferIndex, rightSize)
  return leftCount + await resolveNaiveRange(gpuContext, offset + leftSize, rightSize, bufferIndex, rightPass, onEvaluated)
}

/** Absolute relic counts per slot, used to convert tuple-relative indices to flat global indices. */
export type RelicPartSizes = {
  lSize: number,
  pSize: number,
  fSize: number,
  bSize: number,
  gSize: number,
}

export function decodeTupleGlobalIndex(
  packedIndex: number,
  batchStart: number,
  assignments: WorkgroupEntry[],
  sizes: RelicPartSizes,
  localBits: number,
): number {
  const wgInBatch = packedIndex >>> localBits
  const localOffset = packedIndex & ((1 << localBits) - 1)
  const assignmentIdx = batchStart + wgInBatch
  const a = assignments[assignmentIdx]
  const totalOffset = a.startOffset + localOffset

  const l = totalOffset % a.lSize
  const c1 = (totalOffset - l) / a.lSize
  const p = c1 % a.pSize
  const c2 = (c1 - p) / a.pSize
  const f = c2 % a.fSize
  const c3 = (c2 - f) / a.fSize
  const b = c3 % a.bSize
  const c4 = (c3 - b) / a.bSize
  const g = c4 % a.gSize
  const h = (c4 - g) / a.gSize

  // All six coordinates are slice-relative; expand using the full inventory strides.
  const absF = a.xf + f
  const absB = a.xb + b
  const absG = a.xg + g
  const absH = a.xh + h

  const { lSize, pSize, fSize, bSize, gSize } = sizes
  return (a.xl + l)
    + (a.xp + p) * lSize
    + absF * lSize * pSize
    + absB * lSize * pSize * fSize
    + absG * lSize * pSize * fSize * bSize
    + absH * lSize * pSize * fSize * bSize * gSize
}

function submitTupleBatch(gpuContext: GpuExecutionContext, batchStart: number, batchSize: number, bufferIndex: number): void {
  const threshold = getGpuResultThreshold(gpuContext)
  const paramsBuf = new ArrayBuffer(48)
  new Float32Array(paramsBuf)[0] = threshold
  new Uint32Array(paramsBuf, 4)[0] = batchStart
  writeGpuTieThreshold(paramsBuf, 16, gpuContext)
  submitGpuDispatch(gpuContext, paramsBuf, batchSize, bufferIndex)
}

function processTupleBatch(
  gpuContext: GpuExecutionContext,
  bufferIndex: number,
  batchStart: number,
  assignments: WorkgroupEntry[],
  sizes: RelicPartSizes,
  localBits: number,
  seenIndices?: Set<number>,
): { rawCount: number, validCount: number } {
  const compactReadBuffer = gpuContext.compactReadBuffers[bufferIndex]
  try {
    const mappedRange = compactReadBuffer.getMappedRange()
    const rawCount = new Uint32Array(mappedRange, 0, 1)[0]
    const validCount = new Uint32Array(mappedRange, 4 + gpuContext.compactResultsBufferSize, 1)[0]
    const count = Math.min(rawCount, gpuContext.COMPACT_LIMIT)
    pushCompactResultsToQueue(mappedRange, count, gpuContext, (raw) => decodeTupleGlobalIndex(raw, batchStart, assignments, sizes, localBits), seenIndices)
    return { rawCount, validCount }
  } finally {
    compactReadBuffer.unmap()
  }
}

export async function runTupleDispatch(gpuContext: GpuExecutionContext): Promise<number> {
  if (gpuContext.assignments.length === 0 || !isOptimizationRunActive(gpuContext.request.optimizationId)) return 0

  const localBits = Math.ceil(Math.log2(gpuContext.WORKGROUP_SIZE * gpuContext.CYCLES_PER_INVOCATION))
  const BATCH_WGS = Math.min(2048, gpuContext.assignments.length)

  // Packed index = (workgroup_in_batch << localBits) | threadLocalOffset — must fit u32
  if (localBits + Math.ceil(Math.log2(BATCH_WGS + 1)) > 32) {
    throw new Error(`Packed index overflow: ${localBits} local bits + ${BATCH_WGS} max workgroups exceeds u32`)
  }
  const totalBatches = Math.ceil(gpuContext.assignments.length / BATCH_WGS)
  const assignments = gpuContext.assignments
  const relics = gpuContext.relics
  const sizes: RelicPartSizes = {
    lSize: relics.LinkRope.length,
    pSize: relics.PlanarSphere.length,
    fSize: relics.Feet.length,
    bSize: relics.Body.length,
    gSize: relics.Hands.length,
  }
  const overflowedBatches: number[] = []
  const seenIndices = new Set<number>()
  let permutationsSearched = 0

  // Double-buffered: submit batch N+1 while reading batch N
  let currentBuf = 0

  // Reset start time before first dispatch to exclude pipeline setup from perms/sec
  useOptimizerDisplayStore.getState().setOptimizerStartTime(Date.now())

  // Submit first batch
  const firstBatchSize = Math.min(BATCH_WGS, gpuContext.assignments.length)
  submitTupleBatch(gpuContext, 0, firstBatchSize, currentBuf)

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchStart = batch * BATCH_WGS
    const readBuf = currentBuf

    // Determine next batch
    const hasNext = batch + 1 < totalBatches
    if (hasNext) {
      const nextBuf = 1 - currentBuf
      const nextBatchStart = (batch + 1) * BATCH_WGS
      const nextBatchSize = Math.min(BATCH_WGS, gpuContext.assignments.length - nextBatchStart)
      submitTupleBatch(gpuContext, nextBatchStart, nextBatchSize, nextBuf)
      currentBuf = nextBuf
    }

    await gpuContext.compactReadBuffers[readBuf].mapAsync(GPUMapMode.READ)
    if (!isOptimizationRunActive(gpuContext.request.optimizationId)) {
      gpuContext.compactReadBuffers[readBuf].unmap()
      gpuContext.cancelled = true
      break
    }

    const { rawCount, validCount } = processTupleBatch(gpuContext, readBuf, batchStart, assignments, sizes, localBits, seenIndices)
    permutationsSearched += validCount
    if (rawCount > gpuContext.COMPACT_LIMIT) {
      overflowedBatches.push(batchStart)
    }

    const searchedSnapshot = permutationsSearched
    const progressSnapshot = (batch + 1) / totalBatches
    setTimeout(() => {
      if (!isOptimizationRunActive(gpuContext.request.optimizationId)) return
      useOptimizerDisplayStore.setState({
        optimizerEndTime: Date.now(),
        permutationsResults: gpuContext.resultsQueue.size(),
        permutationsSearched: searchedSnapshot,
        optimizerProgress: progressSnapshot,
      })
    }, 0)

    if (!isOptimizationRunActive(gpuContext.request.optimizationId)) {
      gpuContext.cancelled = true
      break
    }
  }

  // Revisit overflowed batches with tighter threshold
  if (overflowedBatches.length > 0) {
    for (const batchStart of overflowedBatches) {
      if (!isOptimizationRunActive(gpuContext.request.optimizationId)) break

      const batchSize = Math.min(BATCH_WGS, gpuContext.assignments.length - batchStart)
      let rawCount: number
      let retries = 0
      do {
        submitTupleBatch(gpuContext, batchStart, batchSize, 0)
        await gpuContext.compactReadBuffers[0].mapAsync(GPUMapMode.READ)
        if (!isOptimizationRunActive(gpuContext.request.optimizationId)) {
          gpuContext.compactReadBuffers[0].unmap()
          gpuContext.cancelled = true
          return permutationsSearched
        }
        const result = processTupleBatch(gpuContext, 0, batchStart, assignments, sizes, localBits, seenIndices)
        rawCount = result.rawCount
      } while (
        rawCount > gpuContext.COMPACT_LIMIT
        && retries++ < 100000
        && isOptimizationRunActive(gpuContext.request.optimizationId)
      )
      if (rawCount > gpuContext.COMPACT_LIMIT && isOptimizationRunActive(gpuContext.request.optimizationId)) {
        throw new Error('GPU result overflow remained unresolved after retries')
      }
    }
  }

  return permutationsSearched
}

// Reads results from an already-mapped buffer
function readBufferMapped(offset: number, gpuReadBuffer: GPUBuffer, gpuContext: GpuExecutionContext, elementOffset: number = 0) {
  const arrayBuffer = gpuReadBuffer.getMappedRange(elementOffset * 4)
  const array = new Float32Array(arrayBuffer)

  processResults(offset, array, gpuContext, elementOffset)

  if (gpuContext.DEBUG) {
    debugWebgpuOutput(gpuContext, arrayBuffer)
  }
}

function processResults(offset: number, array: Float32Array, gpuContext: GpuExecutionContext, elementOffset: number = 0) {
  const resultsQueue = gpuContext.resultsQueue
  let top = resultsQueue.size() > 0 ? resultsQueue.topPriority() : 0

  let limit = gpuContext.BLOCK_SIZE * gpuContext.CYCLES_PER_INVOCATION
  const maxPermNumber = offset + gpuContext.BLOCK_SIZE * gpuContext.CYCLES_PER_INVOCATION
  const diff = gpuContext.permutations - maxPermNumber
  if (diff < 0) {
    limit += diff
  }

  const indexOffset = offset + elementOffset
  if (resultsQueue.size() >= gpuContext.RESULTS_LIMIT) {
    for (let j = limit - elementOffset - 1; j >= 0; j--) {
      const value = array[j]
      if (value < 0) {
        j += value + 1
        continue
      }
      if (value < top) continue

      top = resultsQueue.fixedSizePushOvercapped(indexOffset + j, value)
    }
  } else {
    for (let j = limit - elementOffset - 1; j >= 0; j--) {
      const value = array[j]
      if (value < 0) {
        j += value + 1
        continue
      }

      if (value < top && resultsQueue.size() >= gpuContext.RESULTS_LIMIT) {
        continue
      }

      resultsQueue.fixedSizePush(indexOffset + j, value)
      top = resultsQueue.topPriority()
    }
  }
}

function pushCompactResultsToQueue(
  mappedRange: ArrayBuffer,
  count: number,
  gpuContext: GpuExecutionContext,
  resolveIndex: (rawIndex: number) => number,
  seenIndices?: Set<number>,
): void {
  if (count === 0) return

  const u32View = new Uint32Array(mappedRange, 4)
  const f32View = new Float32Array(mappedRange, 4)
  const resultsQueue = gpuContext.resultsQueue
  let top = resultsQueue.size() > 0 ? resultsQueue.topPriority() : 0

  if (resultsQueue.size() >= gpuContext.RESULTS_LIMIT) {
    for (let i = 0; i < count; i++) {
      const value = f32View[i * 2 + 1]
      if (value < top) continue
      const globalIndex = resolveIndex(u32View[i * 2])
      if (seenIndices?.has(globalIndex)) continue
      top = resultsQueue.fixedSizePushOvercapped(globalIndex, value)
      seenIndices?.add(globalIndex)
    }
  } else {
    for (let i = 0; i < count; i++) {
      const value = f32View[i * 2 + 1]
      if (value < top && resultsQueue.size() >= gpuContext.RESULTS_LIMIT) continue
      const globalIndex = resolveIndex(u32View[i * 2])
      if (seenIndices?.has(globalIndex)) continue
      resultsQueue.fixedSizePush(globalIndex, value)
      top = resultsQueue.topPriority()
      seenIndices?.add(globalIndex)
    }
  }
}

function processCompactResults(offset: number, count: number, mappedRange: ArrayBuffer, gpuContext: GpuExecutionContext, seenIndices?: Set<number>) {
  pushCompactResultsToQueue(mappedRange, count, gpuContext, (raw) => offset + raw, seenIndices)
}

function outputResults(gpuContext: GpuExecutionContext) {
  const relics: RelicsByPart = gpuContext.relics

  const lSize = relics.LinkRope.length
  const pSize = relics.PlanarSphere.length
  const fSize = relics.Feet.length
  const bSize = relics.Body.length
  const gSize = relics.Hands.length

  const optimizerContext = gpuContext.context
  initializeContextConditionals(optimizerContext)

  const resultArray = gpuContext.resultsQueue.toResults().sort(gpuContext.tieOrder.compareResults)
  const outputs: OptimizerDisplayData[] = []
  const basicStatsArrayCore = new BasicStatsArrayCore(false) as BasicStatsArray
  const computedStats = new ComputedStatsContainer()
  computedStats.initializeArrays(optimizerContext.maxContainerArrayLength, optimizerContext)

  for (let i = 0; i < resultArray.length; i++) {
    const index = resultArray[i].index

    const l = index % lSize
    const c1 = (index - l) / lSize
    const p = c1 % pSize
    const c2 = (c1 - p) / pSize
    const f = c2 % fSize
    const c3 = (c2 - f) / fSize
    const b = c3 % bSize
    const c4 = (c3 - b) / bSize
    const g = c4 % gSize
    const h = (c4 - g) / gSize

    const relicsByPart = {
      Head: relics.Head[h],
      Hands: relics.Hands[g],
      Body: relics.Body[b],
      Feet: relics.Feet[f],
      PlanarSphere: relics.PlanarSphere[p],
      LinkRope: relics.LinkRope[l],
    }

    const { x } = simulateBuild(relicsByPart as SimulationRelicByPart, optimizerContext, basicStatsArrayCore, computedStats)

    const optimizerDisplayData = formatOptimizerDisplayData(x, optimizerContext)
    // GPU rows retain independent xa/ca snapshots; tracing uses a separate simulation.
    delete optimizerDisplayData.tracedX
    optimizerDisplayData.id = index
    outputs.push(optimizerDisplayData)
  }

  if (outputs.length === 0) {
    activateZeroResultSuggestionsModal(gpuContext.request)
  }

  const sortOption = SortOption[gpuContext.request.resultSort as keyof typeof SortOption]
  const showMemo = gpuContext.request.memoDisplay === 'memo'
  const gridSortColumn = gpuContext.request.statDisplay === 'combat'
    ? (showMemo ? sortOption.memoCombatGridColumn : sortOption.combatGridColumn)
    : (showMemo ? sortOption.memoBasicGridColumn : sortOption.basicGridColumn)
  setSortColumn(gridSortColumn)
  OptimizerTabController.setRows(outputs, { column: gridSortColumn, scores: new Map(resultArray.map((r) => [r.index, r.value])) })
  gridStore.optimizerGridApi()?.updateGridOptions({ datasource: OptimizerTabController.getDataSource() })
}
