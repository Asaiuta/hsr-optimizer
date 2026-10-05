import { COMPUTE_ENGINE_GPU_EXPERIMENTAL } from 'lib/constants/constants'
import { generateWgsl } from 'lib/gpu/injection/generateWgsl'
import { GpuBufferLease } from 'lib/gpu/webgpuBufferPool'
import {
  buildWorkgroupAssignments,
  computeTupleParams,
  type FullSizes,
  generateParamsMatrix,
  mergeRelicsIntoArray,
  packRankedRelics,
  serializeAssignments,
  type WorkgroupEntry,
} from 'lib/gpu/webgpuDataTransform'
import { uniformCompatible } from 'lib/gpu/webgpuDevice'
import { getComputePipeline } from 'lib/gpu/webgpuPipelineCache'
import {
  type GpuExecutionContext,
  type RelicsByPart,
} from 'lib/gpu/webgpuTypes'
import {
  PARTS,
  qualifyShieldBound,
} from 'lib/optimization/pruning/shieldBound'
import {
  buildPerSlotSetRanges,
  enumerateValidQuadsD4,
} from 'lib/optimization/relicSetSolver'
import {
  createResultTieOrder,
  OptimizerResultQueue,
} from 'lib/optimization/resultTieOrder'
import { bitpackBooleanArray } from 'lib/optimization/setSolutionBitset'
import {
  OrnamentSetToIndex,
  RelicSetToIndex,
  type SetsOrnaments,
  type SetsRelics,
} from 'lib/sets/setConfigRegistry'
import { type Form } from 'types/form'
import { type OptimizerContext } from 'types/optimizer'
import { type Relic } from 'types/relic'

export function getCompactResultLimit(resultsLimit: number, tupleMode: boolean, debug: boolean): number {
  const capacity = resultsLimit * (tupleMode ? 64 : 4)
  // Small K still needs a useful seed and enough room to avoid repeated readbacks.
  // Tuple and debug layouts retain their existing capacity contracts.
  return tupleMode || debug ? capacity : Math.max(4096, capacity)
}

export function shouldConsiderGpuPruning(permutations: number, dispatchSize: number, targetIterations: number): boolean {
  // Power-of-two workgroup rounding normally produces targetIterations to twice
  // that many passes. Keep these short searches on the batched exhaustive path.
  return Math.ceil(permutations / dispatchSize) > 2 * targetIterations
}

export async function initializeGpuPipeline(
  device: GPUDevice,
  relics: RelicsByPart,
  request: Form,
  context: OptimizerContext,
  permutations: number,
  computeEngine: string,
  relicSetSolutions: number[],
  ornamentSetSolutions: number[],
  debug = false,
  silent = false,
): Promise<GpuExecutionContext> {
  const DEBUG = debug

  // Threads per workgroup
  const WORKGROUP_SIZE = 256

  // Permutations each thread evaluates per dispatch
  const CYCLES_PER_INVOCATION = 256

  // Workgroups dispatched per pass — scaled to ensure enough iterations for UI responsiveness
  const TARGET_ITERATIONS = 4
  const MIN_WORKGROUPS = 64
  const MAX_WORKGROUPS = computeEngine === COMPUTE_ENGINE_GPU_EXPERIMENTAL
    ? Math.min(2048, device.limits.maxComputeWorkgroupsPerDimension)
    : 512
  const neededWorkgroups = 2 ** Math.floor(Math.log2(permutations / WORKGROUP_SIZE / CYCLES_PER_INVOCATION / TARGET_ITERATIONS))
  const NUM_WORKGROUPS = Math.max(MIN_WORKGROUPS, Math.min(MAX_WORKGROUPS, neededWorkgroups))

  // Total threads per dispatch
  const BLOCK_SIZE = WORKGROUP_SIZE * NUM_WORKGROUPS

  // Top-N results to keep
  const RESULTS_LIMIT = request.resultsLimit ?? 1024

  const hasRelicFilter = (request.relicSets?.length ?? 0) > 0
  const TUPLE_MODE = hasRelicFilter && !DEBUG

  // Tuple mode has near-100% pass rate — needs larger compact buffer to avoid overflow revisits
  const COMPACT_OVERFLOW_FACTOR = TUPLE_MODE ? 64 : 4

  // Max compact entries per dispatch before overflow triggers revisit
  const COMPACT_LIMIT = getCompactResultLimit(RESULTS_LIMIT, TUPLE_MODE, DEBUG)

  const wgsl = generateWgsl(context, request, relics, {
    WORKGROUP_SIZE,
    BLOCK_SIZE,
    CYCLES_PER_INVOCATION,
    RESULTS_LIMIT,
    COMPACT_LIMIT,
    DEBUG,
    TUPLE_MODE,
  })

  // A capacity floor must not make previously unaudited K values match the
  // shield fingerprint. Large searches still require the full original contract.
  const shieldBound = COMPACT_LIMIT === RESULTS_LIMIT * COMPACT_OVERFLOW_FACTOR
      && shouldConsiderGpuPruning(permutations, BLOCK_SIZE * CYCLES_PER_INVOCATION, TARGET_ITERATIONS)
      && !DEBUG && !TUPLE_MODE && !request.ornamentSets?.length && request.characterId === '8004' && request.resultSort === 'TALENT_SHIELD'
    ? await qualifyShieldBound(wgsl, new Float32Array(mergeRelicsIntoArray(relics)), context.precomputedStatsData!, PARTS.map((part) => relics[part].length))
    : undefined
  const computePipeline = await getComputePipeline(device, wgsl)

  const bufferLease = new GpuBufferLease(device, !DEBUG)
  const createBuffer = bufferLease.createBuffer
  try {
    // Original dispatch fields followed by 32 bytes for the complete tie threshold.
    const paramsMatrixBufferSize = TUPLE_MODE ? 48 : 64
    // DEBUG writes one full stats container per invocation. Release mode does not use this buffer.
    const resultMatrixBufferSize = getResultMatrixBufferSize(DEBUG, BLOCK_SIZE, context.maxContainerArrayLength)
    const resultMatrixBuffers: [GPUBuffer, GPUBuffer] = [
      createBuffer({ size: resultMatrixBufferSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      createBuffer({ size: resultMatrixBufferSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    ]
    const paramsMatrixBuffer = createBuffer({
      size: paramsMatrixBufferSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })

    const hasOrnamentFilter = (request.ornamentSets?.length ?? 0) > 0

    // Sorts relics in-place by set — required for contiguous set ranges in tuple dispatch.
    // Mutates the caller's arrays; outputResults reads from the same sorted references.
    if (TUPLE_MODE) {
      const byRelicSet = (a: Relic, b: Relic) => RelicSetToIndex[a.set as SetsRelics] - RelicSetToIndex[b.set as SetsRelics]
      const byOrnamentSet = (a: Relic, b: Relic) => OrnamentSetToIndex[a.set as SetsOrnaments] - OrnamentSetToIndex[b.set as SetsOrnaments]

      relics.Head.sort(byRelicSet)
      relics.Hands.sort(byRelicSet)
      relics.Body.sort(byRelicSet)
      relics.Feet.sort(byRelicSet)
      relics.PlanarSphere.sort(byOrnamentSet)
      relics.LinkRope.sort(byOrnamentSet)
    }

    // Build tuple assignments for set-filtered dispatch
    let assignmentBuffer: GPUBuffer | null = null
    let assignments: WorkgroupEntry[] = []

    if (TUPLE_MODE) {
      const ranges = buildPerSlotSetRanges(relics)
      const quads = enumerateValidQuadsD4(relicSetSolutions, ranges)
      const fullSizes: FullSizes = {
        pSize: relics.PlanarSphere.length,
        lSize: relics.LinkRope.length,
      }
      const wgCapacity = WORKGROUP_SIZE * CYCLES_PER_INVOCATION
      const tupleParams = quads.map((q) => computeTupleParams(q, ranges))
      assignments = buildWorkgroupAssignments(tupleParams, fullSizes, wgCapacity)
      const serialized = serializeAssignments(assignments)

      assignmentBuffer = createGpuBuffer(device, createBuffer, new Uint32Array(serialized), GPUBufferUsage.STORAGE)
    }

    const mergedRelics = new Float32Array(mergeRelicsIntoArray(relics))
    const tieOrder = createResultTieOrder(relics)
    const relicsMatrixBuffer = createGpuBuffer(
      device,
      createBuffer,
      DEBUG ? mergedRelics : packRankedRelics(mergedRelics, tieOrder.packedRanks),
      GPUBufferUsage.STORAGE,
    )
    const relicSetSolutionsMatrixBuffer = hasRelicFilter
      ? createGpuBuffer(device, createBuffer, new Int32Array(bitpackBooleanArray(relicSetSolutions)), GPUBufferUsage.STORAGE)
      : null
    const ornamentSetSolutionsMatrixBuffer = hasOrnamentFilter
      ? createGpuBuffer(device, createBuffer, new Int32Array(bitpackBooleanArray(ornamentSetSolutions)), GPUBufferUsage.STORAGE)
      : null
    const precomputedStatsBuffer = createGpuBuffer(
      device,
      createBuffer,
      context.precomputedStatsData!,
      uniformCompatible() ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE,
    )

    const bindGroup0Entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: paramsMatrixBuffer } },
    ]
    if (TUPLE_MODE && assignmentBuffer) {
      bindGroup0Entries.push({ binding: 1, resource: { buffer: assignmentBuffer } })
    }
    const bindGroup0 = device.createBindGroup({
      layout: computePipeline.getBindGroupLayout(0),
      entries: bindGroup0Entries,
    })

    const bindGroup1 = device.createBindGroup({
      layout: computePipeline.getBindGroupLayout(1),
      entries: [
        { binding: 0, resource: { buffer: relicsMatrixBuffer } },
        ...ornamentSetSolutionsMatrixBuffer ? [{ binding: 1, resource: { buffer: ornamentSetSolutionsMatrixBuffer } }] : [],
        ...relicSetSolutionsMatrixBuffer ? [{ binding: 2, resource: { buffer: relicSetSolutionsMatrixBuffer } }] : [],
        { binding: 3, resource: { buffer: precomputedStatsBuffer } },
      ],
    })

    // Atomic compaction buffers
    const COMPACT_ENTRY_BYTES = 8 // CompactEntry: u32 index (4B) + f32 value (4B)
    const compactResultsBufferSize = COMPACT_LIMIT * COMPACT_ENTRY_BYTES

    const compactCountBuffers: [GPUBuffer, GPUBuffer] = [
      createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
      createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
    ]
    const validCountBuffers: [GPUBuffer, GPUBuffer] = [
      createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
      createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
    ]
    const compactResultsBuffers: [GPUBuffer, GPUBuffer] = [
      createBuffer({ size: compactResultsBufferSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
      createBuffer({ size: compactResultsBufferSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    ]

    // Merged read buffer: [compactCount(4B) | CompactEntry[](N*8B) | validCount(4B)]
    const compactReadBufferSize = 4 + compactResultsBufferSize + 4
    const compactReadBuffers: [GPUBuffer, GPUBuffer] = [
      createBuffer({ size: compactReadBufferSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      createBuffer({ size: compactReadBufferSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    ]

    const bindGroups2: [GPUBindGroup, GPUBindGroup] = [0, 1].map((i) =>
      device.createBindGroup({
        layout: computePipeline.getBindGroupLayout(2),
        entries: getResultBindGroupEntries(
          DEBUG,
          resultMatrixBuffers[i],
          compactCountBuffers[i],
          compactResultsBuffers[i],
          validCountBuffers[i],
        ),
      })
    ) as [GPUBindGroup, GPUBindGroup]

    const gpuReadBuffers: [GPUBuffer, GPUBuffer] = [
      createBuffer({ size: resultMatrixBufferSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      createBuffer({ size: resultMatrixBufferSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    ]

    const iterations = Math.ceil(permutations / BLOCK_SIZE / CYCLES_PER_INVOCATION)
    const resultsQueue = new OptimizerResultQueue(RESULTS_LIMIT, tieOrder)

    return {
      bufferLease,
      WORKGROUP_SIZE,
      NUM_WORKGROUPS,
      BLOCK_SIZE,
      CYCLES_PER_INVOCATION,
      RESULTS_LIMIT,
      DEBUG,

      request,
      context,

      paramsMatrixBufferSize,
      resultMatrixBufferSize,
      permutations,
      iterations,
      relics,
      resultsQueue,
      tieOrder,
      shieldBound,
      cancelled: false,
      computeEngine,

      device,
      computePipeline,
      bindGroup0,
      bindGroup1,
      bindGroups2,
      paramsMatrixBuffer,
      resultMatrixBuffers,
      relicsMatrixBuffer,
      relicSetSolutionsMatrixBuffer,
      ornamentSetSolutionsMatrixBuffer,
      precomputedStatsBuffer,

      gpuReadBuffers,

      TUPLE_MODE,
      assignmentBuffer,
      assignments,

      COMPACT_LIMIT,
      compactResultsBufferSize,
      compactReadBufferSize,
      compactCountBuffers,
      compactResultsBuffers,
      compactReadBuffers,
      validCountBuffers,
    }
  } catch (error) {
    // A shared device survives failed jobs, so release partially initialized buffers too.
    bufferLease.release()
    throw error
  }
}

export type ExecutionPassResult = {
  gpuReadBuffer: GPUBuffer,
  compactReadBuffer: GPUBuffer,
}

export function submitGpuDispatch(gpuContext: GpuExecutionContext, paramsData: ArrayBuffer, workgroupCount: number, bufferIndex: number): void {
  const device = gpuContext.device
  device.queue.writeBuffer(gpuContext.paramsMatrixBuffer, 0, paramsData)

  const compactCountBuffer = gpuContext.compactCountBuffers[bufferIndex]
  const compactResultsBuffer = gpuContext.compactResultsBuffers[bufferIndex]
  const compactReadBuffer = gpuContext.compactReadBuffers[bufferIndex]
  const validCountBuffer = gpuContext.validCountBuffers[bufferIndex]

  const commandEncoder = device.createCommandEncoder()

  commandEncoder.clearBuffer(validCountBuffer, 0, 4)
  if (!gpuContext.DEBUG) commandEncoder.clearBuffer(compactCountBuffer, 0, 4)

  const passEncoder = commandEncoder.beginComputePass()
  passEncoder.setPipeline(gpuContext.computePipeline)
  passEncoder.setBindGroup(0, gpuContext.bindGroup0)
  passEncoder.setBindGroup(1, gpuContext.bindGroup1)
  passEncoder.setBindGroup(2, gpuContext.bindGroups2[bufferIndex])
  passEncoder.dispatchWorkgroups(workgroupCount)
  passEncoder.end()

  if (!gpuContext.DEBUG) {
    commandEncoder.copyBufferToBuffer(compactCountBuffer, 0, compactReadBuffer, 0, 4)
    commandEncoder.copyBufferToBuffer(compactResultsBuffer, 0, compactReadBuffer, 4, gpuContext.compactResultsBufferSize)
    commandEncoder.copyBufferToBuffer(validCountBuffer, 0, compactReadBuffer, 4 + gpuContext.compactResultsBufferSize, 4)
  }

  if (gpuContext.DEBUG) {
    commandEncoder.copyBufferToBuffer(
      gpuContext.resultMatrixBuffers[bufferIndex],
      0,
      gpuContext.gpuReadBuffers[bufferIndex],
      0,
      gpuContext.resultMatrixBufferSize,
    )
  }

  device.queue.submit([commandEncoder.finish()])
}

export function generateExecutionPass(
  gpuContext: GpuExecutionContext,
  offset: number,
  bufferIndex = 0,
  rangeSize = gpuContext.BLOCK_SIZE * gpuContext.CYCLES_PER_INVOCATION,
): ExecutionPassResult {
  const paramsData = generateParamsMatrix(offset, gpuContext.relics, gpuContext, rangeSize)
  const workgroups = Math.ceil(rangeSize / (gpuContext.WORKGROUP_SIZE * gpuContext.CYCLES_PER_INVOCATION))
  submitGpuDispatch(gpuContext, paramsData, workgroups, bufferIndex)
  return {
    gpuReadBuffer: gpuContext.gpuReadBuffers[bufferIndex],
    compactReadBuffer: gpuContext.compactReadBuffers[bufferIndex],
  }
}

export function getResultMatrixBufferSize(debug: boolean, blockSize: number, containerLength: number): number {
  return debug ? Float32Array.BYTES_PER_ELEMENT * blockSize * containerLength : 4
}

export function getResultBindGroupEntries(
  debug: boolean,
  resultMatrixBuffer: GPUBuffer,
  compactCountBuffer: GPUBuffer,
  compactResultsBuffer: GPUBuffer,
  validCountBuffer: GPUBuffer,
): GPUBindGroupEntry[] {
  return debug
    ? [
      { binding: 0, resource: { buffer: resultMatrixBuffer } },
      { binding: 3, resource: { buffer: validCountBuffer } },
    ]
    : [
      { binding: 1, resource: { buffer: compactCountBuffer } },
      { binding: 2, resource: { buffer: compactResultsBuffer } },
      { binding: 3, resource: { buffer: validCountBuffer } },
    ]
}

function createGpuBuffer(
  device: GPUDevice,
  createBuffer: (descriptor: GPUBufferDescriptor) => GPUBuffer,
  matrix: Int32Array | Uint32Array | Float32Array,
  usage: GPUBufferUsageFlags,
) {
  const gpuBuffer = createBuffer({
    size: matrix.byteLength,
    usage: usage | GPUBufferUsage.COPY_DST,
  })

  device.queue.writeBuffer(gpuBuffer, 0, matrix.buffer, matrix.byteOffset, matrix.byteLength)

  return gpuBuffer
}

export function destroyPipeline(gpuContext: GpuExecutionContext) {
  gpuContext.bufferLease.release()
}
