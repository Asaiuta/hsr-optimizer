// @vitest-environment jsdom
import {
  buildWorkgroupAssignments,
  serializeAssignments,
  type WorkgroupEntry,
} from 'lib/gpu/webgpuDataTransform'
import { decodeTupleGlobalIndex } from 'lib/gpu/webgpuOptimizer'
import {
  expect,
  it,
} from 'vitest'

const capacity = 65536
const tuple = { xh: 23, hSize: 1, xg: 17, gSize: 1, xb: 11, bSize: 1, xf: 7, fSize: 1 }

it.each([[1, 2 ** 31 - 1], [32768, 65536], [65536, 32768], [3, 715827883], [65535, 65537], [65536, 65536], [641, 6700417], [70000, 70000]])(
  'bounds and covers ornament dimensions %i x %i exactly',
  (pSize, lSize) => {
    const assignments = buildWorkgroupAssignments([tuple], { pSize, lSize }, capacity)
    expect(assignments.reduce((n, a) => n + BigInt(a.permLimit), 0n)).toBe(BigInt(pSize) * BigInt(lSize))
    const slices = new Map<string, { a: WorkgroupEntry, end: number }>()
    for (const a of assignments) {
      if (a.startOffset < 0 || a.startOffset + a.permLimit > 2 ** 31 - 1 || a.pSize * a.lSize > 2 ** 31 - 1) throw Error('Unbounded assignment')
      const key = `${a.xp}/${a.xl}/${a.pSize}/${a.lSize}`
      const slice = slices.get(key) ?? { a, end: 0 }
      expect(a.startOffset).toBe(slice.end)
      slice.end += a.permLimit
      slices.set(key, slice)
    }
    const rectangles = [...slices.values()]
    for (const { a, end } of rectangles) {
      expect(end).toBe(a.pSize * a.lSize)
      expect(a.xp + a.pSize).toBeLessThanOrEqual(pSize)
      expect(a.xl + a.lSize).toBeLessThanOrEqual(lSize)
    }
    // Disjoint in-bounds rectangles plus the exact total area prove full coverage.
    for (let i = 0; i < rectangles.length; i++) {
      for (let j = i + 1; j < rectangles.length; j++) {
        const a = rectangles[i].a, b = rectangles[j].a
        const overlap = a.xp < b.xp + b.pSize && b.xp < a.xp + a.pSize && a.xl < b.xl + b.lSize && b.xl < a.xl + a.lSize
        expect(overlap).toBe(false)
      }
    }
    const sizes = { lSize, pSize, fSize: 9, bSize: 13, gSize: 19 }
    const selected = assignments.filter((_, i) => i === 0 || i === assignments.length - 1 || i % 4093 === 0)
    const bytes = new Uint32Array(serializeAssignments(selected))
    expect(bytes.length).toBe(selected.length * 16)
    for (let i = 0; i < selected.length; i++) {
      const a = selected[i]
      expect(Array.from(bytes.slice(i * 16 + 12, i * 16 + 16))).toEqual([a.xp, a.xl, 0, 0])
      for (const local of [0, a.permLimit - 1]) {
        const offset = BigInt(a.startOffset + local)
        const p = BigInt(a.xp) + offset / BigInt(a.lSize)
        const l = BigInt(a.xl) + offset % BigInt(a.lSize)
        const expected = ((((23n * 19n + 17n) * 13n + 11n) * 9n + 7n) * BigInt(pSize) + p) * BigInt(lSize) + l
        expect(BigInt(decodeTupleGlobalIndex(i * capacity + local, 0, selected, sizes, 16))).toBe(expected)
      }
    }
  },
)

it('preserves ordinary assignment order, offsets and the 64-byte layout', () => {
  const a = { ...tuple, xh: 0, hSize: 2, xg: 0, xb: 0, xf: 0 }
  const b = { ...a, xh: 2, hSize: 1 }
  const result = buildWorkgroupAssignments([a, b], { pSize: 3, lSize: 5 }, 16)
  expect(result.map((r) => [r.xh, r.hSize, r.startOffset, r.permLimit, r.xp, r.xl])).toEqual([
    [2, 1, 0, 15, 0, 0],
    [0, 2, 0, 16, 0, 0],
    [0, 2, 16, 14, 0, 0],
  ])
  expect(Array.from(new Uint32Array(serializeAssignments(result)).slice(0, 16))).toEqual([2, 1, 0, 1, 0, 1, 0, 1, 3, 5, 15, 0, 0, 0, 0, 0])
})

it('decodes every carry across six nonzero slice origins with independent nested loops', () => {
  const a: WorkgroupEntry = { ...tuple, hSize: 2, gSize: 2, bSize: 2, fSize: 2, xp: 3, pSize: 2, xl: 2, lSize: 3, startOffset: 5, permLimit: 91 }
  const global = { lSize: 11, pSize: 13, fSize: 17, bSize: 19, gSize: 23 }
  const expected: number[] = []
  for (let h = a.xh; h < a.xh + a.hSize; h++) {
    for (let g = a.xg; g < a.xg + a.gSize; g++) {
      for (let b = a.xb; b < a.xb + a.bSize; b++) {
        for (let f = a.xf; f < a.xf + a.fSize; f++) {
          for (let p = a.xp; p < a.xp + a.pSize; p++) {
            for (let l = a.xl; l < a.xl + a.lSize; l++) expected.push(((((h * 23 + g) * 19 + b) * 17 + f) * 13 + p) * 11 + l)
          }
        }
      }
    }
  }
  for (let i = 0; i < a.permLimit; i++) expect(decodeTupleGlobalIndex(i, 0, [a], global, 16)).toBe(expected[i + a.startOffset])
})

it('rejects unrepresentable dimensions and inexact counts before allocating assignments', () => {
  for (const n of [0, -1, 0.5, Infinity, 2 ** 31]) expect(() => buildWorkgroupAssignments([tuple], { pSize: n, lSize: 1 }, capacity)).toThrow()
  expect(() => buildWorkgroupAssignments([tuple], { pSize: 1, lSize: 1 }, 0)).toThrow()
  expect(() => buildWorkgroupAssignments([{ ...tuple, hSize: 2 ** 30 }], { pSize: 2 ** 30, lSize: 1 }, capacity)).toThrow('exact integer')
})

it('rejects invalid outer origins and exclusive coordinate endpoints', () => {
  for (const xh of [-1, 0.5, NaN, Infinity, 2 ** 31 - 1]) {
    expect(() => buildWorkgroupAssignments([{ ...tuple, xh }], { pSize: 1, lSize: 1 }, capacity)).toThrow('Tuple ranges')
  }
  expect(() => buildWorkgroupAssignments([{ ...tuple, xf: 2 ** 31 - 2, fSize: 2 }], { pSize: 1, lSize: 1 }, capacity)).toThrow('Tuple ranges')
})
