// @vitest-environment jsdom
import {
  getCompactResultLimit,
  getResultBindGroupEntries,
  getResultMatrixBufferSize,
  shouldConsiderGpuPruning,
} from 'lib/gpu/webgpuInternals'
import {
  describe,
  expect,
  it,
} from 'vitest'

const buffer = {} as GPUBuffer

describe('WebGPU search scheduling', () => {
  it.each([1, 10, 100])('gives small K=%i a full seed without changing the requested result count', (limit) => {
    expect(getCompactResultLimit(limit, false, false)).toBe(4096)
    expect(getCompactResultLimit(limit, true, false)).toBe(limit * 64)
    expect(getCompactResultLimit(limit, false, true)).toBe(limit * 4)
  })

  it('preserves existing large-K and tuple/debug capacities', () => {
    expect(getCompactResultLimit(1024, false, false)).toBe(4096)
    expect(getCompactResultLimit(4096, false, false)).toBe(16384)
    expect(getCompactResultLimit(10, true, true)).toBe(640)
  })

  it.each([4_194_304, 33_554_432, 134_217_728])('keeps short searches exhaustive for dispatch size %i', (dispatchSize) => {
    expect(shouldConsiderGpuPruning(dispatchSize, dispatchSize, 4)).toBe(false)
    expect(shouldConsiderGpuPruning(dispatchSize * 8, dispatchSize, 4)).toBe(false)
    expect(shouldConsiderGpuPruning(dispatchSize * 8 + 1, dispatchSize, 4)).toBe(true)
  })

  it('avoids the measured small shield regression while retaining the trillion-search path', () => {
    expect(shouldConsiderGpuPruning(12_625_614, 4_194_304, 4)).toBe(false)
    expect(shouldConsiderGpuPruning(4_311_364_200_000, 33_554_432, 4)).toBe(true)
    expect(shouldConsiderGpuPruning(4_311_364_200_000, 134_217_728, 4)).toBe(true)
  })
})

describe('WebGPU result buffer layout', () => {
  it('binds the debug results array and valid permutation counter', () => {
    const entries = getResultBindGroupEntries(true, buffer, buffer, buffer, buffer)

    expect(entries.map((entry) => entry.binding)).toEqual([0, 3])
  })

  it('binds the release compaction buffers and valid permutation counter', () => {
    const entries = getResultBindGroupEntries(false, buffer, buffer, buffer, buffer)

    expect(entries.map((entry) => entry.binding)).toEqual([1, 2, 3])
  })

  it('sizes debug output by the full container stride', () => {
    expect(getResultMatrixBufferSize(true, 16_384, 97)).toBe(6_356_992)
    expect(getResultMatrixBufferSize(true, 16_384, 257)).toBe(16_842_752)
    expect(getResultMatrixBufferSize(false, 16_384, 257)).toBe(4)
  })
})
