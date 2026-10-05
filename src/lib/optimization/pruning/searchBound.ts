import {
  type Block,
  type Bound,
  canPrune,
  children,
} from './shieldBound'

export type BoundSearchProgress = { evaluated: number, pruned: number, visited: number }
type Search = {
  leafSize: number,
  isActive: () => boolean,
  cutoff: () => { value: number, full: boolean },
  dispatch: (offset: number, size: number) => Promise<number>,
  onProgress: (progress: BoundSearchProgress) => void,
}

/** Disjoint best-bound-first DFS. A score equal to the cutoff is never pruned. */
export async function searchBound(bound: Bound, search: Search): Promise<BoundSearchProgress> {
  const progress = { evaluated: 0, pruned: 0, visited: 0 }
  const stack: Block[] = [{ prefix: [], offset: 0, size: bound.total, upper: bound.upper([]) }]
  const scheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler
  let sliceStart = performance.now()
  while (stack.length && search.isActive()) {
    if (++progress.visited % 4096 === 0 && performance.now() - sliceStart >= 8) {
      search.onProgress({ ...progress })
      if (scheduler?.yield) await scheduler.yield()
      else await new Promise((resolve) => setTimeout(resolve, 0))
      sliceStart = performance.now()
      if (!search.isActive()) break
    }
    const block = stack.pop()!
    const cutoff = search.cutoff()
    if (canPrune(block.upper, cutoff.value, cutoff.full)) {
      progress.pruned += block.size
    } else if (block.prefix.length >= 4 || block.size <= search.leafSize) {
      progress.evaluated += await search.dispatch(block.offset, block.size)
      sliceStart = performance.now()
      search.onProgress({ ...progress })
    } else {
      const next = children(bound, block)
      for (let i = next.length - 1; i >= 0; i--) stack.push(next[i])
    }
  }
  search.onProgress({ ...progress })
  return progress
}
