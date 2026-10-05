import { inventoryRevision } from 'lib/automation/inventory'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { getCharacters } from 'lib/stores/character/characterStore'
import { usePrivateScannerState } from 'lib/tabs/tabImport/scannerStore'
import { useWarpCalculatorStore } from 'lib/tabs/tabWarp/useWarpCalculatorStore'

export function listCharacters(includeUnimported: boolean) {
  const metadata = getGameMetadata()
  const owned = new Map(getCharacters().map((character) => [character.id, character]))
  const characters = includeUnimported ? Object.values(metadata.characters) : getCharacters().map((character) => metadata.characters[character.id])
  return {
    inventoryRevision: inventoryRevision(),
    characters: characters.map((meta) => {
      const character = owned.get(meta.id)
      return {
        id: meta.id,
        name: meta.name,
        path: meta.path,
        element: meta.element,
        rarity: meta.rarity,
        imported: !!character,
        eidolon: character?.form.characterEidolon,
        lightCone: character?.form.lightCone,
        lightConeSuperimposition: character?.form.lightConeSuperimposition,
        equipped: { ...character?.equipped },
        builds: character?.builds?.map((build) => build.name) ?? [],
      }
    }),
  }
}

export function listLightCones(offset: number, limit: number, path?: string, ownedOnly = false) {
  const metadata = getGameMetadata().lightCones
  const scanner = usePrivateScannerState.getState()
  const cones = ownedOnly
    ? Object.values(scanner.lightCones).map((cone) => ({ ...cone, path: metadata[cone.id as keyof typeof metadata]?.path }))
    : Object.values(metadata).map(({ id, name, path, rarity, stats, superimpositions }) => ({ id, name, path, rarity, stats, superimpositions }))
  const filtered = path ? cones.filter((cone) => cone.path === path) : cones
  return {
    source: ownedOnly ? scanner.inventorySource : 'gameMetadata',
    available: !ownedOnly || !!scanner.inventorySource,
    offset,
    total: filtered.length,
    lightCones: structuredClone(filtered.slice(offset, offset + limit)),
  }
}

export function getResources(offset: number, limit: number) {
  const scanner = usePrivateScannerState.getState()
  const materials = Object.values(scanner.materials)
  return structuredClone({
    source: scanner.inventorySource,
    available: !!scanner.inventorySource,
    funds: scanner.gachaFunds,
    offset,
    total: materials.length,
    materials: materials.slice(offset, offset + limit),
    planner: useWarpCalculatorStore.getState().request,
  })
}
