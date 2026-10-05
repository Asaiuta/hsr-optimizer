/** O(1) scheduler storage, independent of the number of permutations. */
export function createBatchCursor(permutations: number, maxSize: number, increment = 20000) {
  let skip = 0
  let size = 0
  return {
    hasNext: () => skip < permutations,
    next() {
      if (skip >= permutations) return null
      size = Math.min(maxSize, size + increment, permutations - skip)
      const batch = { skip, runSize: size }
      skip += size
      return batch
    },
  }
}
