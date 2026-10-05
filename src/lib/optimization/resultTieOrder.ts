import { FixedSizeNumericMinQueue } from 'lib/dataStructures/fixedSizeMinQueue'

export const RESULT_PARTS = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope'] as const
type IdentifiedRelics = Record<typeof RESULT_PARTS[number], readonly { id: string }[]>
type Result = { index: number, value: number }

/** IDs are opaque strings, compared by JS code-unit order, never locale/numeric sorting. */
export function createResultTieOrder(relics: IdentifiedRelics) {
  const sizes = RESULT_PARTS.map((part) => relics[part].length)
  const total = sizes.reduce((a, b) => a * b, 1)
  if (!Number.isSafeInteger(total)) throw new Error('Optimizer combination identities exceed the safe integer range')
  const inverse = RESULT_PARTS.map((part) => {
    const items = relics[part]
    const seen = new Set<string>()
    for (const item of items) {
      if (typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error(`Invalid or duplicate optimizer relic ID in ${part}`)
      seen.add(item.id)
    }
    return Uint32Array.from(items.map((_, i) => i).sort((a, b) => items[a].id < items[b].id ? -1 : items[a].id > items[b].id ? 1 : 0))
  })
  const ranks = inverse.map((indices) => {
    const result = new Uint32Array(indices.length)
    indices.forEach((index, rank) => result[index] = rank)
    return result
  })
  function convert(index: number, tables: readonly Uint32Array[]): number {
    let result = 0, multiplier = 1
    for (let slot = 5; slot >= 0; slot--) {
      const position = index % sizes[slot]
      result += tables[slot][position] * multiplier
      index = (index - position) / sizes[slot]
      multiplier *= sizes[slot]
    }
    return result
  }
  const toCanonical = (index: number) => convert(index, ranks)
  const toOriginal = (index: number) => convert(index, inverse)
  const rankTuple = (index: number) => {
    const tuple = new Uint32Array(6)
    for (let slot = 5; slot >= 0; slot--) {
      const position = index % sizes[slot]
      tuple[slot] = ranks[slot][position]
      index = (index - position) / sizes[slot]
    }
    return tuple
  }
  const packedRanks = new Uint32Array(sizes.reduce((a, b) => a + b, 0))
  let offset = 0
  for (const slot of ranks) {
    packedRanks.set(slot, offset)
    offset += slot.length
  }
  return {
    toCanonical,
    toOriginal,
    rankTuple,
    packedRanks,
    compareIndices: (left: number, right: number) => toCanonical(left) - toCanonical(right),
    compareResults: (left: Result, right: Result) => right.value - left.value || toCanonical(left.index) - toCanonical(right.index),
  }
}

export type ResultTieOrder = ReturnType<typeof createResultTieOrder>

/** Preserve traversal indices outside the heap; only its internal keys are canonical. */
export class OptimizerResultQueue extends FixedSizeNumericMinQueue {
  constructor(limit: number, readonly tieOrder: ResultTieOrder) {
    super(limit, true)
  }

  override topKey(): number {
    return this.tieOrder.toOriginal(super.topKey())
  }

  override fixedSizePush(index: number, value: number): void {
    super.fixedSizePush(this.tieOrder.toCanonical(index), value)
  }

  override fixedSizePushOvercapped(index: number, value: number): number {
    return super.fixedSizePushOvercapped(this.tieOrder.toCanonical(index), value)
  }

  override toResults(): Result[] {
    return super.toResults().map((r) => ({ index: this.tieOrder.toOriginal(r.index), value: r.value }))
  }
}
