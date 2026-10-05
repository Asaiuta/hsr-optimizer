import {
  allocate,
  type AllocationCandidate,
} from 'lib/automation/allocation'
import {
  expect,
  it,
} from 'vitest'

it('chooses a lower-ranked candidate when it improves total conflict-free value', () => {
  const groups = [
    { weight: 1, candidates: [{ relicIds: ['shared'], value: 100 }, { relicIds: ['a'], value: 90 }] },
    { weight: 1, candidates: [{ relicIds: ['shared'], value: 100 }, { relicIds: ['b'], value: 10 }] },
  ]
  expect(allocate(groups, 1000)).toMatchObject({ indices: [1, 0], score: 1.9, searchComplete: true })
  expect(allocate(groups, 1)).toMatchObject({ indices: null, searchComplete: false })
  expect(allocate(groups.map((group) => ({ ...group, candidates: group.candidates.slice(0, 1) })), 1000))
    .toMatchObject({ indices: null, searchComplete: true })
})

it('matches exhaustive enumeration across overlapping candidate sets and weights', () => {
  let seed = 9183
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
  for (let fixture = 0; fixture < 30; fixture++) {
    const groups = Array.from({ length: 4 }, () => ({
      weight: 1 + random(),
      candidates: Array.from({ length: 4 }, (_, index) => ({
        relicIds: ['head-' + Math.floor(random() * 5), 'body-' + Math.floor(random() * 5)],
        value: 100 - index * 10,
      })),
    }))
    if (fixture % 2) groups[0].candidates.reverse()
    let best: number | null = null
    const visit = (depth: number, selected: AllocationCandidate[], score: number) => {
      if (depth === groups.length) {
        best = Math.max(best ?? -Infinity, score)
        return
      }
      for (const candidate of groups[depth].candidates) {
        if (selected.some((previous) => previous.relicIds.some((id) => candidate.relicIds.includes(id)))) continue
        visit(depth + 1, [...selected, candidate], score + candidate.value / 100 * groups[depth].weight)
      }
    }
    visit(0, [], 0)
    const result = allocate(groups, 100000)
    expect(result.searchComplete).toBe(true)
    if (best === null) expect(result.score).toBeNull()
    else expect(result.score).toBeCloseTo(best, 10)
    if (result.indices) {
      const ids = result.indices.flatMap((index, group) => groups[group].candidates[index].relicIds)
      expect(new Set(ids).size).toBe(ids.length)
    }
  }
})
