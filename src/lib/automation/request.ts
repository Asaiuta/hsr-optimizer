import type { RequestInput } from 'lib/automation/contracts'
import * as core from 'lib/automation/core/request'
import { getCharacters } from 'lib/stores/character/characterStore'

export function requireCharacter(id: string) {
  return core.requireCharacter(getCharacters(), id)
}

export function requireBuild(characterId: string, name: string) {
  return core.requireBuild(getCharacters(), characterId, name)
}

export function resolveRequest(input: RequestInput) {
  return core.resolveRequest(input, getCharacters())
}
