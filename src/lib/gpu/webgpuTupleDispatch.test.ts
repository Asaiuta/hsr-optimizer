// @vitest-environment jsdom
import type { WorkgroupEntry } from 'lib/gpu/webgpuDataTransform'
import { submitGpuDispatch } from 'lib/gpu/webgpuInternals'
import { runTupleDispatch } from 'lib/gpu/webgpuOptimizer'
import type { GpuExecutionContext } from 'lib/gpu/webgpuTypes'
import {
  createResultTieOrder,
  OptimizerResultQueue,
  RESULT_PARTS,
} from 'lib/optimization/resultTieOrder'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest'

vi.mock(
  'lib/gpu/webgpuInternals',
  () => ({ submitGpuDispatch: vi.fn(), generateExecutionPass: vi.fn(), initializeGpuPipeline: vi.fn(), destroyPipeline: vi.fn() }),
)
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('GPUMapMode', { READ: 1 })
  useOptimizerDisplayStore.setState({ ...useOptimizerDisplayStore.getInitialState(), optimizationId: 'tuple-test', optimizationInProgress: true })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function fixture(limit: number, count = 256, width = 64, large = false, ties = false) {
  const sizes = large ? [500, 461, 55, 109, 30, 104] : [1, 1, 1, 1, 1, count]
  const relics = Object.fromEntries(
    RESULT_PARTS.map((part, slot) => [part, Array.from({ length: sizes[slot] }, (_, i) => ({ id: `${part}-${String(sizes[slot] - i).padStart(6, '0')}` }))]),
  ) as Record<typeof RESULT_PARTS[number], { id: string }[]>
  const order = createResultTieOrder(relics)
  const base = large ? ((((453 * 461 + 451) * 55 + 52) * 109 + 106) * 30) * 104 : 0
  const assignments = Array.from({ length: Math.ceil(count / width) }, (_, i): WorkgroupEntry => ({
    xh: large ? 453 : 0,
    xg: large ? 451 : 0,
    xb: large ? 52 : 0,
    xf: large ? 106 : 0,
    hSize: 1,
    gSize: 1,
    bSize: 1,
    fSize: 1,
    xp: 0,
    xl: 0,
    pSize: 1,
    lSize: sizes[5],
    startOffset: i * width,
    permLimit: Math.min(width, count - i * width),
  }))
  const score = (local: number) => ties ? 7 : local + 1
  const valid = (local: number) => local % 5 !== 0
  const calls: { bufferIndex: number, ranges: { offset: number, size: number }[] }[] = []
  const buffers = [0, 1].map(() => ({
    mapped: false,
    data: new ArrayBuffer(0),
    mapAsync: vi.fn(async function(this: { mapped: boolean }) {
      expect(this.mapped).toBe(false)
      this.mapped = true
    }),
    getMappedRange() {
      expect(this.mapped).toBe(true)
      return this.data
    },
    unmap() {
      expect(this.mapped).toBe(true)
      this.mapped = false
    },
  }))
  const capacity = limit * 4
  const context = {
    WORKGROUP_SIZE: 8,
    CYCLES_PER_INVOCATION: 8,
    assignments,
    relics,
    RESULTS_LIMIT: limit,
    COMPACT_LIMIT: capacity,
    compactResultsBufferSize: capacity * 8,
    compactReadBuffers: buffers,
    resultsQueue: new OptimizerResultQueue(limit, order),
    tieOrder: order,
    request: { optimizationId: 'tuple-test' },
  } as unknown as GpuExecutionContext
  vi.mocked(submitGpuDispatch).mockImplementation((_ctx, params, workgroups, bufferIndex) => {
    const start = new Uint32Array(params)[1]
    const chosen = assignments.slice(start, start + workgroups)
    const ranges = chosen.map((a) => ({ offset: a.startOffset, size: a.permLimit }))
    calls.push({ bufferIndex, ranges })
    const buffer = buffers[bufferIndex]
    expect(buffer.mapped).toBe(false)
    buffer.data = new ArrayBuffer(8 + capacity * 8)
    const u = new Uint32Array(buffer.data), f = new Float32Array(buffer.data)
    const floor = new Float32Array(params)[0]
    let raw = 0, passed = 0
    chosen.forEach((a, group) => {
      for (let j = 0; j < a.permLimit; j++) {
        const local = a.startOffset + j
        if (!valid(local)) continue
        passed++
        const value = score(local)
        const betterTie = value === floor && context.resultsQueue.size() >= limit && order.compareIndices(base + local, context.resultsQueue.topKey()) < 0
        if (!(value > floor || betterTie)) continue
        if (raw < capacity) {
          u[1 + raw * 2] = group * 64 + j
          f[2 + raw * 2] = value
        }
        raw++
      }
    })
    u[0] = raw
    u[u.length - 1] = passed
  })
  const expected = Array.from({ length: count }, (_, local) => local).filter(valid)
    .sort((a, b) => score(b) - score(a) || b - a).slice(0, limit).map((local) => ({ index: base + local, value: score(local) }))
  return { context, calls, buffers, expected, passed: Array.from({ length: count }, (_, i) => i).filter(valid).length }
}

it.each([1, 7, 1024])('resolves dense tuple overflow without duplicate results or counts for K=%i', async (limit) => {
  const f = fixture(limit)
  expect(await runTupleDispatch(f.context)).toBe(f.passed)
  expect(f.context.resultsQueue.toResults().sort(f.context.tieOrder.compareResults)).toEqual(f.expected)
  expect(f.buffers.every((b) => !b.mapped)).toBe(true)
  if (limit === 1) expect(f.calls.length).toBeGreaterThan(1)
})

it('preserves full same-score ranks and nonzero assignment offsets at multi-trillion indices', async () => {
  const f = fixture(1, 101, 64, true, true)
  expect(await runTupleDispatch(f.context)).toBe(f.passed)
  expect(f.context.resultsQueue.toResults()).toEqual(f.expected)
  expect(f.expected[0].index).toBeGreaterThan(2 ** 32)
  expect(f.calls[0].ranges.some((r) => r.offset > 0)).toBe(true)
})

it('preserves both batches when using double buffers and revisiting overflow', async () => {
  const f = fixture(1, 2050 * 8, 8)
  expect(await runTupleDispatch(f.context)).toBe(f.passed)
  expect(f.calls[0].bufferIndex).toBe(0)
  expect(f.calls[1].bufferIndex).toBe(1)
  expect(f.calls[2].bufferIndex).toBe(0)
  expect(f.context.resultsQueue.toResults()).toEqual(f.expected)
  expect(f.buffers.every((b) => !b.mapped)).toBe(true)
})

it('does not consume a cancelled readback or publish over a replacement run', async () => {
  const f = fixture(1)
  f.buffers[0].mapAsync.mockImplementation(async () => {
    f.buffers[0].mapped = true
    useOptimizerDisplayStore.setState({ optimizationId: 'replacement', optimizerProgress: 0.25 })
  })
  expect(await runTupleDispatch(f.context)).toBe(0)
  expect(f.calls).toHaveLength(1)
  expect(f.context.resultsQueue.size()).toBe(0)
  expect(f.buffers[0].mapped).toBe(false)
  expect(useOptimizerDisplayStore.getState().optimizerProgress).toBe(0.25)
})

it('does not consume or resubmit an overflow revisit cancelled during readback', async () => {
  const f = fixture(1, 64)
  let initialResults: ReturnType<typeof f.context.resultsQueue.toResults> = []
  f.buffers[0].mapAsync.mockImplementation(async () => {
    f.buffers[0].mapped = true
    if (f.calls.length === 2) {
      initialResults = f.context.resultsQueue.toResults()
      useOptimizerDisplayStore.setState({ optimizationInProgress: false })
    }
  })
  expect(await runTupleDispatch(f.context)).toBe(f.passed)
  expect(f.calls).toHaveLength(2)
  expect(f.context.resultsQueue.toResults()).toEqual(initialResults)
  expect(f.context.cancelled).toBe(true)
  expect(f.buffers[0].mapped).toBe(false)
})

it.each([1, 2])('unmaps when consuming readback %i throws', async (readback) => {
  const f = fixture(1, 64)
  const original = f.buffers[0].getMappedRange.bind(f.buffers[0])
  vi.spyOn(f.buffers[0], 'getMappedRange').mockImplementation(() => {
    if (f.calls.length === readback) throw new Error('invalid readback')
    return original()
  })
  await expect(runTupleDispatch(f.context)).rejects.toThrow('invalid readback')
  expect(f.buffers[0].mapped).toBe(false)
  expect(f.calls).toHaveLength(readback)
})

it('does not submit an already cancelled run', async () => {
  const f = fixture(1)
  useOptimizerDisplayStore.setState({ optimizationInProgress: false })
  expect(await runTupleDispatch(f.context)).toBe(0)
  expect(f.calls).toHaveLength(0)
})
