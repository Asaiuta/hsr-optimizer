import {
  AutomationError,
  type commandSchemas,
  type RequestInput,
} from 'lib/automation/contracts'
import { inventoryRevision } from 'lib/automation/inventory'
import {
  requireCharacter,
  resolveRequest,
} from 'lib/automation/request'
import { existingRelics } from 'lib/automation/simulation'
import { serializeFromOptimizer } from 'lib/services/buildConverter'
import { applyRelicAssignments } from 'lib/services/equipmentService'
import { SaveState } from 'lib/state/saveState'
import { useCharacterStore } from 'lib/stores/character/characterStore'
import { getRelicById } from 'lib/stores/relic/relicStore'
import type { Build } from 'types/character'
import type { LightConeId } from 'types/lightCone'
import type { z } from 'zod'

type Assignment = z.infer<typeof commandSchemas.check_builds>['assignments'][number]

export function listBuilds(characterId: string, offset: number, limit: number) {
  const builds = requireCharacter(characterId).builds ?? []
  return {
    inventoryRevision: inventoryRevision(),
    total: builds.length,
    offset,
    builds: builds.slice(offset, offset + limit).map((build) => ({
      ...structuredClone(build),
      missingRelics: Object.values(build.equipped).filter((id) => id && !getRelicById(id)),
      occupiedRelics: Object.values(build.equipped).flatMap((id) => {
        const relic = id ? getRelicById(id) : undefined
        return relic?.equippedBy && relic.equippedBy !== characterId ? [{ id, characterId: relic.equippedBy }] : []
      }),
    })),
  }
}

export function saveNamedBuild(request: ReturnType<typeof resolveRequest>, name: string, equipped: Build) {
  const character = requireCharacter(request.form.characterId)
  if (character.builds?.some((build) => build.name === name)) throw new AutomationError('ALREADY_EXISTS', `Build ${name} already exists`)
  const build = serializeFromOptimizer(name, character.id, request.state as typeof request.state & { lightCone: LightConeId }, equipped)
  useCharacterStore.getState().setCharacter({ ...character, builds: [...(character.builds ?? []), build] })
  SaveState.delayedSave()
  return { name, characterId: character.id, relics: { ...equipped }, inventoryRevision: inventoryRevision() }
}

export function saveBuild(input: RequestInput & { name: string, relicIds?: string[] }) {
  const relics = existingRelics(input.characterId, input.relicIds, input.buildName)
  return saveNamedBuild(resolveRequest(input), input.name, Object.fromEntries(relics.map((relic) => [relic.part, relic.id])))
}

export function deleteBuild(characterId: string, name: string) {
  const character = requireCharacter(characterId)
  const index = character.builds?.findIndex((build) => build.name === name) ?? -1
  if (index < 0) throw new AutomationError('NOT_FOUND', `Build ${name} is unavailable`)
  const builds = [...character.builds!]
  builds.splice(index, 1)
  useCharacterStore.getState().setCharacter({ ...character, builds })
  SaveState.delayedSave()
  return { characterId, name, inventoryRevision: inventoryRevision() }
}

export function checkBuilds(assignments: Assignment[]) {
  const characters = new Set(assignments.map((assignment) => assignment.characterId))
  if (characters.size !== assignments.length) throw new AutomationError('INVALID_INPUT', 'Assign each character only once')
  const used = new Map<string, string>()
  const conflicts: { type: 'shared' | 'occupied', relicId: string, characterId: string, otherCharacterId: string }[] = []
  const resolved = assignments.map((assignment) => {
    const character = requireCharacter(assignment.characterId)
    const relics = existingRelics(character.id, assignment.relicIds, assignment.name)
    for (const relic of relics) {
      const previous = used.get(relic.id)
      if (previous) conflicts.push({ type: 'shared', relicId: relic.id, characterId: character.id, otherCharacterId: previous })
      used.set(relic.id, character.id)
      if (relic.equippedBy && !characters.has(relic.equippedBy)) {
        conflicts.push({ type: 'occupied', relicId: relic.id, characterId: character.id, otherCharacterId: relic.equippedBy })
      }
    }
    return { characterId: character.id, relicIds: relics.map((relic) => relic.id) }
  })
  return { inventoryRevision: inventoryRevision(), valid: conflicts.length === 0, conflicts, assignments: resolved }
}

export function equipBuilds(input: z.infer<typeof commandSchemas.equip_builds>) {
  if (inventoryRevision() !== input.expectedRevision) throw new AutomationError('STALE_INVENTORY', 'Inventory changed; check assignments again')
  const plan = checkBuilds(input.assignments)
  if (plan.conflicts.some((conflict) => conflict.type === 'shared' || input.onConflict === 'reject')) {
    throw new AutomationError('EQUIPMENT_CONFLICT', JSON.stringify(plan.conflicts))
  }
  applyRelicAssignments(plan.assignments)
  SaveState.delayedSave()
  return { inventoryRevision: inventoryRevision(), assignments: plan.assignments, transferred: plan.conflicts }
}
