import type { Parts } from 'lib/constants/constants'
import type { RelicsByPart } from 'lib/gpu/webgpuTypes'
import type { Relic } from 'types/relic'

export type OptimizerWorkerRelic = Pick<Relic, 'id' | 'set' | 'condensedStats'>
export type OptimizerWorkerRelics = Record<Parts, readonly OptimizerWorkerRelic[]>

/** Prepare once per search; postMessage still clones each task's input independently. */
export function prepareOptimizerWorkerRelics(relics: RelicsByPart): OptimizerWorkerRelics {
  const project = (items: readonly Relic[]) => items.map(({ id, set, condensedStats }) => ({ id, set, condensedStats }))
  // Preserve inventory and stat addition order, IDs, and full number precision.
  return {
    Head: project(relics.Head),
    Hands: project(relics.Hands),
    Body: project(relics.Body),
    Feet: project(relics.Feet),
    PlanarSphere: project(relics.PlanarSphere),
    LinkRope: project(relics.LinkRope),
  }
}
