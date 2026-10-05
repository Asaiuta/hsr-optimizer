import {
  expect,
  it,
} from 'vitest'
import { searchBound } from './searchBound'
import { type Bound } from './shieldBound'

it('partitions the domain and never prunes equal bounds or a non-full queue', async () => {
  const bound: Bound = { total: 64, sizes: [2, 2, 2, 2, 2, 2], slots: [], upper: (prefix) => prefix[0] === 0 ? 9 : 10 }
  for (const full of [false, true]) {
    const evaluated: number[] = []
    const progress = await searchBound(bound, {
      leafSize: 4,
      isActive: () => true,
      cutoff: () => ({ value: 10, full }),
      onProgress: () => {},
      dispatch: async (offset, size) => {
        evaluated.push(...Array.from({ length: size }, (_, i) => offset + i))
        return size
      },
    })
    expect(progress.evaluated + progress.pruned).toBe(64)
    expect(progress.pruned).toBe(full ? 32 : 0)
    expect(evaluated.sort((a, b) => a - b)).toEqual(Array.from({ length: full ? 32 : 64 }, (_, i) => i + (full ? 32 : 0)))
  }
})

it('stops between GPU ranges and propagates device failures', async () => {
  const bound: Bound = { total: 64, sizes: [2, 2, 2, 2, 2, 2], slots: [], upper: () => 10 }
  let active = true
  const search = {
    leafSize: 4,
    isActive: () => active,
    cutoff: () => ({ value: 10, full: true }),
    onProgress: () => {},
    dispatch: async (_offset: number, size: number) => {
      active = false
      return size
    },
  }
  expect((await searchBound(bound, search)).evaluated).toBe(4)
  active = true
  await expect(searchBound(bound, {
    ...search,
    dispatch: async () => {
      throw new Error('device lost')
    },
  })).rejects.toThrow('device lost')
})
