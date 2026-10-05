// @vitest-environment jsdom
import { getGpuResultThreshold } from 'lib/gpu/webgpuDataTransform'
import { generateExecutionPass } from 'lib/gpu/webgpuInternals'
import {
  runGpuDispatch,
  runNaiveDispatch,
} from 'lib/gpu/webgpuOptimizer'
import { type GpuExecutionContext } from 'lib/gpu/webgpuTypes'
import {
  createResultTieOrder,
  OptimizerResultQueue,
  RESULT_PARTS,
} from 'lib/optimization/resultTieOrder'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

vi.mock('lib/gpu/webgpuInternals', () => ({
  generateExecutionPass: vi.fn(),
  initializeGpuPipeline: vi.fn(),
  destroyPipeline: vi.fn(),
  submitGpuDispatch: vi.fn(),
}))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('GPUMapMode', { READ: 1 })
  useOptimizerDisplayStore.setState({ ...useOptimizerDisplayStore.getInitialState(), optimizationId: 'test', optimizationInProgress: true })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

function searchFixture(scores: number[], limit: number, valid = (_index: number) => true) {
  const relics = Object.fromEntries(
    RESULT_PARTS.map((
      part,
      slot,
    ) => [part, Array.from({ length: slot === 0 ? scores.length : 1 }, (_, i) => ({ id: `${part}-${String(scores.length - i).padStart(8, '0')}` }))]),
  ) as Record<typeof RESULT_PARTS[number], { id: string }[]>
  const tieOrder = createResultTieOrder(relics)
  const capacity = limit * 4
  const stride = 8192
  const calls: { offset: number, size: number }[] = []
  const leaves: { offset: number, size: number }[] = []
  const buffers = [0, 1].map(() => ({
    data: new ArrayBuffer(8 + capacity * 8),
    mapped: false,
    async mapAsync() {
      expect(this.mapped).toBe(false)
      this.mapped = true
    },
    getMappedRange() {
      expect(this.mapped).toBe(true)
      return this.data
    },
    unmap() {
      expect(this.mapped).toBe(true)
      this.mapped = false
    },
  }))
  const context = {
    BLOCK_SIZE: stride / 256,
    CYCLES_PER_INVOCATION: 256,
    RESULTS_LIMIT: limit,
    COMPACT_LIMIT: capacity,
    compactResultsBufferSize: capacity * 8,
    permutations: scores.length,
    resultsQueue: new OptimizerResultQueue(limit, tieOrder),
    tieOrder,
    request: { optimizationId: 'test' },
    DEBUG: false,
  } as unknown as GpuExecutionContext

  vi.mocked(generateExecutionPass).mockImplementation((ctx, offset, bufferIndex = 0, rangeSize = stride) => {
    const size = Math.min(rangeSize, scores.length - offset)
    calls.push({ offset, size })
    const buffer = buffers[bufferIndex]
    expect(buffer.mapped).toBe(false)
    buffer.data = new ArrayBuffer(8 + capacity * 8)
    const u32 = new Uint32Array(buffer.data)
    const f32 = new Float32Array(buffer.data)
    let count = 0
    let validCount = 0
    const threshold = getGpuResultThreshold(ctx)
    // Deliberately return low scores first: a truncated parent must not cause us to lose its better tail.
    for (let i = 0; i < size; i++) {
      if (!valid(offset + i)) continue
      validCount++
      const value = Math.fround(scores[offset + i])
      const betterTie = value === threshold && ctx.resultsQueue.size() >= limit && tieOrder.compareIndices(offset + i, ctx.resultsQueue.topKey()) < 0
      if (!(value > threshold || betterTie)) continue
      if (count < capacity) {
        u32[1 + count * 2] = i
        f32[2 + count * 2] = value
      }
      count++
    }
    u32[0] = count
    u32[1 + capacity * 2] = validCount
    if (count <= capacity) leaves.push({ offset, size })
    return { compactReadBuffer: buffer as unknown as GPUBuffer, gpuReadBuffer: {} as GPUBuffer }
  })
  return { context, calls, leaves, buffers }
}

describe('bounded GPU overflow search', () => {
  it.each(['clustered', 'alternating', 'descending'])('preserves the complete stable top-K with %s overflow density', async (kind) => {
    const scores = Array.from(
      { length: 22001 },
      (_, i) => kind === 'descending' ? 22001 - i : kind === 'clustered' ? (i > 15000 ? 10000 : i % 17) : (i * 31) % 503,
    )
    const { context } = searchFixture(scores, 17)
    const expected = scores.map((value, index) => ({ value, index })).sort(context.tieOrder.compareResults).slice(0, 17)
    expect(await runNaiveDispatch(context)).toBe(scores.length)
    expect(context.resultsQueue.toResults().sort(context.tieOrder.compareResults)).toEqual(expected)
  })

  it('uses the complete same-score cutoff across pipelining and overflow retries', async () => {
    const { context, calls } = searchFixture(Array(19001).fill(7), 7)
    expect(await runGpuDispatch(context)).toBe(19001)
    expect(context.resultsQueue.toResults().sort(context.tieOrder.compareResults).map((r) => r.index)).toEqual([
      19000,
      18999,
      18998,
      18997,
      18996,
      18995,
      18994,
    ])
    expect(calls.length).toBeGreaterThan(3)
  })

  it('stops the qualified branch after cancellation without publishing into a replacement run', async () => {
    const { context, calls, buffers } = searchFixture(Array(64).fill(7), 7)
    context.shieldBound = { sizes: [4, 2, 2, 2, 1, 1], slots: [], total: 32, upper: () => 100 }
    buffers[0].mapAsync = async function() {
      this.mapped = true
      useOptimizerDisplayStore.setState({ optimizationId: 'replacement', optimizerProgress: 0.25 })
    }
    expect(await runGpuDispatch(context)).toBe(0)
    expect(context.cancelled).toBe(true)
    expect(calls).toHaveLength(1)
    expect(context.resultsQueue.size()).toBe(0)
    expect(buffers[0].mapped).toBe(false)
    expect(useOptimizerDisplayStore.getState().optimizerProgress).toBe(0.25)
  })
  it.each([1, 10, 100, 1024])('matches exhaustive top-K with K=%i through dense ascending overflows', async (limit) => {
    const scores = Array.from({ length: 20003 }, (_, i) => i + 1)
    const { context, calls, leaves, buffers } = searchFixture(scores, limit)
    expect(await runNaiveDispatch(context)).toBe(scores.length)
    const actual = context.resultsQueue.toResults().sort((a, b) => b.value - a.value)
    expect(actual).toEqual(scores.map((value, index) => ({ index, value })).slice(-limit).reverse())
    // Successful leaves partition the input exactly, including seed and final partial ranges.
    let end = 0
    for (const leaf of leaves.sort((a, b) => a.offset - b.offset)) {
      expect(leaf.offset).toBe(end)
      end += leaf.size
    }
    expect(end).toBe(scores.length)
    expect(new Set(calls.map(({ offset, size }) => `${offset}/${size}`)).size).toBe(calls.length)
    expect(buffers.every((buffer) => !buffer.mapped)).toBe(true)
  })

  it.each(['ties', 'sparse', 'empty', 'fewer-than-k'])('preserves exact scores and unique candidates for %s inputs', async (kind) => {
    const scores = Array.from({ length: 19001 }, (_, i) => kind === 'ties' ? 7 : (i * 43) % 1009)
    const valid = (index: number) => kind === 'empty' ? false : kind === 'fewer-than-k' ? index < 3 : kind === 'sparse' ? index % 31 === 0 : true
    const { context } = searchFixture(scores, 10, valid)
    const expected = scores.filter((_, index) => valid(index)).sort((a, b) => b - a).slice(0, 10)
    expect(await runNaiveDispatch(context)).toBe(scores.filter((_, index) => valid(index)).length)
    const actual = context.resultsQueue.toResults()
    expect(actual.map((result) => result.value).sort((a, b) => b - a)).toEqual(expected)
    expect(new Set(actual.map((result) => result.index)).size).toBe(actual.length)
  })

  it('unmaps and stops submitting after cancellation during readback', async () => {
    const { context, calls, buffers } = searchFixture(Array.from({ length: 20000 }, (_, i) => i), 10)
    buffers[0].mapAsync = async function() {
      this.mapped = true
      useOptimizerDisplayStore.setState({ optimizationInProgress: false })
    }
    expect(await runNaiveDispatch(context)).toBe(0)
    expect(calls).toHaveLength(1)
    expect(buffers[0].mapped).toBe(false)
    expect(context.resultsQueue.size()).toBe(0)
  })

  it('stops splitting on cancellation with the other buffer already in flight', async () => {
    const { context, calls, buffers } = searchFixture(Array.from({ length: 20000 }, (_, i) => i), 10)
    let reads = 0
    buffers[0].mapAsync = async function() {
      this.mapped = true
      if (++reads === 3) useOptimizerDisplayStore.setState({ optimizationInProgress: false })
    }
    await runNaiveDispatch(context)
    // Seed, two pipelined parents, then the first child; no child or sibling follows cancellation.
    expect(calls).toHaveLength(4)
    expect(buffers.every((buffer) => !buffer.mapped)).toBe(true)
    expect(context.cancelled).toBe(true)
  })

  it('fails after unmapping if the GPU overflows a range that fits the buffer', async () => {
    const { context, calls, buffers } = searchFixture([1, 2, 3], 10)
    buffers[0].mapAsync = async function() {
      this.mapped = true
      new Uint32Array(this.data)[0] = context.COMPACT_LIMIT + 1
    }
    await expect(runNaiveDispatch(context)).rejects.toThrow('GPU result count exceeded the dispatched range')
    expect(calls).toHaveLength(1)
    expect(buffers[0].mapped).toBe(false)
  })
})
