export type AllocationCandidate = { relicIds: string[], value: number }

/** Exact within the supplied candidates when searchComplete is true. O(candidates + depth) storage. */
export function allocate(groups: { candidates: AllocationCandidate[], weight: number }[], maxNodes: number): {
  indices: number[] | null,
  score: number | null,
  nodes: number,
  searchComplete: boolean,
  upperBound: number | null,
} {
  const order = groups.map((group, index) => ({ ...group, index, bestValue: Math.max(0, ...group.candidates.map((candidate) => candidate.value)) }))
    .sort((a, b) => a.candidates.length - b.candidates.length)
  const bounds = new Float64Array(order.length + 1)
  for (let i = order.length - 1; i >= 0; i--) bounds[i] = bounds[i + 1] + order[i].weight
  const used = new Set<string>()
  const selected = Array.from<number>({ length: order.length })
  let best: number[] | null = null
  let bestScore = -Infinity
  let nodes = 0
  let searchComplete = true
  function visit(depth: number, score: number) {
    if (nodes >= maxNodes) {
      searchComplete = false
      return
    }
    nodes++
    if (score + bounds[depth] <= bestScore + 1e-12) return
    if (depth === order.length) {
      bestScore = score
      best = [...selected]
      return
    }
    const group = order[depth]
    const denominator = group.bestValue
    for (let i = 0; i < group.candidates.length && searchComplete; i++) {
      // Count conflicts too, so the work limit also bounds scans of rejected candidates.
      if (nodes >= maxNodes) {
        searchComplete = false
        return
      }
      nodes++
      const candidate = group.candidates[i]
      if (candidate.relicIds.some((id) => used.has(id))) continue
      for (const id of candidate.relicIds) used.add(id)
      selected[group.index] = i
      visit(depth + 1, score + group.weight * candidate.value / denominator)
      for (const id of candidate.relicIds) used.delete(id)
    }
  }
  visit(0, 0)
  return {
    indices: best,
    score: best === null ? null : bestScore,
    nodes,
    searchComplete,
    upperBound: searchComplete ? (best === null ? null : bestScore) : bounds[0],
  }
}
