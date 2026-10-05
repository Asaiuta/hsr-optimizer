import {
  AutomationError,
  type RequestInput,
} from 'lib/automation/contracts'
import { Constants } from 'lib/constants/constants'
import { ComboType } from 'lib/optimization/rotation/comboType'
import { type TurnAbilityName } from 'lib/optimization/rotation/turnAbilityConfig'
import { deserializeBuild } from 'lib/services/buildConverter'
import { getGameMetadata } from 'lib/state/gameMetadata'
import {
  displayToInternal,
  patchComboConditionalDefault,
} from 'lib/stores/optimizerForm/optimizerFormConversions'
import { createDefaultTeammate } from 'lib/stores/optimizerForm/optimizerFormDefaults'
import { computeLoadForm } from 'lib/stores/optimizerForm/optimizerFormStoreActions'
import type {
  OptimizerRequestState,
  TeammateState,
} from 'lib/stores/optimizerForm/optimizerFormTypes'
import type { Character } from 'types/character'

export function requireCharacter(characters: readonly Character[], id: string) {
  const character = characters.find((entry) => entry.id === id)
  if (!character) throw new AutomationError('NOT_FOUND', `Character ${id} is not imported`)
  return character
}

export function requireBuild(characters: readonly Character[], characterId: string, name: string) {
  const build = requireCharacter(characters, characterId).builds?.find((build) => build.name === name)
  if (!build) throw new AutomationError('NOT_FOUND', `Build ${name} is unavailable for ${characterId}`)
  return build
}

function validateIdentity(characterId: string | undefined, lightCone: string | undefined, requireCone = true) {
  const metadata = getGameMetadata()
  if (!characterId || !Object.hasOwn(metadata.characters, characterId)) throw new AutomationError('INVALID_INPUT', `Unknown character: ${characterId}`)
  if (!lightCone && !requireCone) return
  if (!lightCone || !Object.hasOwn(metadata.lightCones, lightCone)) throw new AutomationError('INVALID_INPUT', `Unknown or missing light cone: ${lightCone}`)
  const character = metadata.characters[characterId as keyof typeof metadata.characters]
  const cone = metadata.lightCones[lightCone as keyof typeof metadata.lightCones]
  if (character.path !== cone.path) throw new AutomationError('INVALID_INPUT', 'Character and light cone paths do not match')
}

export function resolveRequest(input: RequestInput, characters: readonly Character[]) {
  const character = requireCharacter(characters, input.characterId)
  const base = computeLoadForm(structuredClone(character.form))
  if (input.buildName) Object.assign(base, deserializeBuild(requireBuild(characters, input.characterId, input.buildName), character.form))
  const { statFilters, teammates, rotation, ...patch } = input.settings ?? {}
  if (patch.lightCone && patch.lightCone !== base.lightCone) base.lightConeConditionals = {}
  const state = { ...base, ...patch, resultsLimit: patch.resultsLimit ?? 10 } as OptimizerRequestState
  state.rank = characters.findIndex((entry) => entry.id === character.id)
  state.statFilters = { ...base.statFilters }
  for (const [key, value] of Object.entries(statFilters ?? {})) {
    state.statFilters[key as keyof typeof state.statFilters] = value ?? undefined
  }
  if (teammates) {
    state.teammates = teammates.map((teammate) => {
      if (!teammate) return createDefaultTeammate()
      validateIdentity(teammate.characterId, teammate.lightCone, false)
      return { ...createDefaultTeammate(), ...teammate } as TeammateState
    }) as OptimizerRequestState['teammates']
  }
  validateIdentity(state.characterId, state.lightCone)
  for (const teammate of state.teammates) {
    if (teammate.characterId) validateIdentity(teammate.characterId, teammate.lightCone, false)
  }
  for (const excluded of state.exclude) requireCharacter(characters, excluded)
  for (const [key, min] of Object.entries(state.statFilters)) {
    if (!key.startsWith('min')) continue
    const max = state.statFilters[key.replace('min', 'max') as keyof typeof state.statFilters]
    if (min != null && max != null && min > max) throw new AutomationError('INVALID_INPUT', `${key} exceeds its maximum`)
  }
  const parts = { mainBody: 'Body', mainFeet: 'Feet', mainPlanarSphere: 'PlanarSphere', mainLinkRope: 'LinkRope' } as const
  for (const [field, part] of Object.entries(parts)) {
    const allowed: readonly string[] = Constants.PartsMainStats[part]
    if (state[field as keyof typeof parts].some((stat) => !allowed.includes(stat))) throw new AutomationError('INVALID_INPUT', `Invalid main stat for ${part}`)
  }
  // Reuse the same conditional initialization and unit conversion as the UI.
  const normalized = computeLoadForm(displayToInternal(state))
  if (rotation) {
    normalized.comboType = ComboType.ADVANCED
    normalized.comboTurnAbilities = ['NULL', ...rotation as TurnAbilityName[]]
    normalized.comboStateJson = '{}'
    normalized.comboPreprocessor = false
  }
  if (patch.characterConditionals) normalized.comboStateJson = patchComboConditionalDefault(normalized.comboStateJson, 'character', patch.characterConditionals)
  if (patch.lightConeConditionals) normalized.comboStateJson = patchComboConditionalDefault(normalized.comboStateJson, 'lightCone', patch.lightConeConditionals)
  for (const index of [0, 1, 2] as const) {
    const teammate = teammates?.[index]
    if (teammate?.characterConditionals) {
      normalized.comboStateJson = patchComboConditionalDefault(normalized.comboStateJson, 'character', teammate.characterConditionals, index)
    }
    if (teammate?.lightConeConditionals) {
      normalized.comboStateJson = patchComboConditionalDefault(normalized.comboStateJson, 'lightCone', teammate.lightConeConditionals, index)
    }
  }
  const form = displayToInternal(normalized)
  return { state: normalized, form }
}
