import { createBatchCursor } from 'lib/optimization/batchCursor'
import {
  describe,
  expect,
  it,
} from 'vitest'

describe('optimizer batch cursor', () => {
  it('covers a non-aligned search space exactly once, including a short tail', () => {
    const cursor = createBatchCursor(105003, 40000)
    const batches = []
    while (cursor.hasNext()) batches.push(cursor.next())
    expect(batches).toEqual([{ skip: 0, runSize: 20000 }, { skip: 20000, runSize: 40000 }, { skip: 60000, runSize: 40000 }, { skip: 100000, runSize: 5003 }])
    expect(cursor.next()).toBeNull()
  })
  it('handles empty and very large spaces without materializing batches', () => {
    expect(createBatchCursor(0, 100000).next()).toBeNull()
    const cursor = createBatchCursor(1e15, 100000)
    expect(cursor.next()).toEqual({ skip: 0, runSize: 20000 })
    expect(cursor.next()).toEqual({ skip: 20000, runSize: 40000 })
    expect(cursor.hasNext()).toBe(true)
  })
})
