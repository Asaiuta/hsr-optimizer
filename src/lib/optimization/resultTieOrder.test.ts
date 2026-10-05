import {
  describe,
  expect,
  it,
} from 'vitest'
import {
  createResultTieOrder,
  OptimizerResultQueue,
  RESULT_PARTS,
} from './resultTieOrder'

function inventory(sizes = [2, 2, 2, 2, 2, 2]) {
  return Object.fromEntries(
    RESULT_PARTS.map((part, slot) => [part, Array.from({ length: sizes[slot] }, (_, i) => ({ id: `${slot}:${sizes[slot] - i}` }))]),
  ) as Record<typeof RESULT_PARTS[number], { id: string }[]>
}

function ids(index: number, relics: ReturnType<typeof inventory>) {
  const result = Array<string>(6)
  for (let slot = 5; slot >= 0; slot--) {
    const choices = relics[RESULT_PARTS[slot]]
    result[slot] = choices[index % choices.length].id
    index = Math.floor(index / choices.length)
  }
  return result
}

describe('optimizer result tie order', () => {
  it('rejects ambiguous or missing inventory identities', () => {
    const relics = inventory()
    relics.Head[1].id = relics.Head[0].id
    expect(() => createResultTieOrder(relics)).toThrow('Invalid or duplicate optimizer relic ID in Head')
    relics.Head[1].id = ''
    expect(() => createResultTieOrder(relics)).toThrow('Invalid or duplicate optimizer relic ID in Head')
  })
  it('matches an independent full sort after arrival reversal and local top-K merging', () => {
    const relics = inventory(), order = createResultTieOrder(relics)
    const input = Array.from({ length: 64 }, (_, index) => ({ index, value: index % 3 }))
    const expected = [...input].sort((a, b) => {
      if (a.value !== b.value) return b.value - a.value
      const left = ids(a.index, relics), right = ids(b.index, relics)
      for (let slot = 0; slot < 6; slot++) if (left[slot] !== right[slot]) return left[slot] < right[slot] ? -1 : 1
      return 0
    }).slice(0, 7)
    for (const sequence of [input, [...input].reverse()]) {
      const direct = new OptimizerResultQueue(7, order), merged = new OptimizerResultQueue(7, order)
      for (const r of sequence) direct.fixedSizePush(r.index, r.value)
      for (let start = 0; start < input.length; start += 11) {
        const local = new OptimizerResultQueue(7, order)
        for (const r of sequence.slice(start, start + 11)) local.fixedSizePush(r.index, r.value)
        for (const r of local.toResults()) merged.fixedSizePush(r.index, r.value)
      }
      expect(direct.toResults().sort(order.compareResults)).toEqual(expected)
      expect(merged.toResults().sort(order.compareResults)).toEqual(expected)
      expect(direct.topKey()).toBe(expected.at(-1)!.index)
    }
  })

  it('uses opaque string IDs independently of inventory or tuple sorting', () => {
    const first = inventory([4, 1, 1, 1, 1, 1])
    first.Head = ['a', '2', 'A', '10'].map((id) => ({ id }))
    const second = { ...first, Head: [...first.Head].reverse() }
    for (const relics of [first, second]) {
      const order = createResultTieOrder(relics), queue = new OptimizerResultQueue(3, order)
      for (let i = 0; i < 4; i++) queue.fixedSizePush(i, 0)
      expect(queue.toResults().sort(order.compareResults).map((r) => ids(r.index, relics)[0])).toEqual(['10', '2', 'A'])
    }
  })

  it('preserves multi-trillion indices and exactly serializes six u32 ranks', () => {
    const sizes = [500, 461, 55, 109, 30, 104], total = sizes.reduce((a, b) => a * b, 1)
    const relics = inventory(sizes), order = createResultTieOrder(relics)
    for (const index of [0, 2 ** 32 + 123, 3_913_631_766_286, total - 1]) {
      const canonical = order.toCanonical(index)
      expect(Number.isSafeInteger(canonical)).toBe(true)
      expect(order.toOriginal(canonical)).toBe(index)
      expect(order.rankTuple(index).reduce((key, rank, slot) => key * sizes[slot] + rank, 0)).toBe(canonical)
    }
    const queue = new OptimizerResultQueue(1, order)
    queue.fixedSizePush(total - 1, 1)
    queue.fixedSizePush(2 ** 32 + 123, 1)
    expect(queue.topKey()).toBe(order.compareIndices(total - 1, 2 ** 32 + 123) < 0 ? total - 1 : 2 ** 32 + 123)
  })

  it('never turns close scores into ties and handles push-pop replacement', () => {
    const order = createResultTieOrder(inventory([2, 1, 1, 1, 1, 1]))
    const queue = new OptimizerResultQueue(1, order)
    queue.fixedSizePush(1, 1)
    queue.fixedSizePushOvercapped(0, 1 + 2 ** -23)
    expect(queue.toResults()).toEqual([{ index: 0, value: 1 + 2 ** -23 }])
    queue.fixedSizePushOvercapped(1, 1)
    expect(queue.topKey()).toBe(0)
  })
})
