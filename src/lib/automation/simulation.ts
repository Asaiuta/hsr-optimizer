import type { simulationSchema } from 'lib/automation/contracts'
import * as core from 'lib/automation/core/simulation'
import { inventoryRevision } from 'lib/automation/inventory'
import { getCharacters } from 'lib/stores/character/characterStore'
import { useRelicStore } from 'lib/stores/relic/relicStore'
import type { z } from 'zod'

export { numericStats, validateRelicSlot } from 'lib/automation/core/simulation'

export function existingRelics(characterId: string, ids?: string[], buildName?: string) {
  return core.existingRelics(getCharacters(), useRelicStore.getState().relicsById, characterId, ids, buildName)
}

export function simulate(input: z.infer<typeof simulationSchema>) {
  return { inventoryRevision: inventoryRevision(), ...core.simulate(input, getCharacters(), useRelicStore.getState().relicsById) }
}

export function compare(baseline: z.infer<typeof simulationSchema>, candidates: z.infer<typeof simulationSchema>[]) {
  const result = core.compare(baseline, candidates, getCharacters(), useRelicStore.getState().relicsById)
  const revision = inventoryRevision()
  return {
    baseline: { inventoryRevision: revision, ...result.baseline },
    candidates: result.candidates.map((candidate) => ({ inventoryRevision: revision, ...candidate })),
  }
}
