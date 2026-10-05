import { parseSave } from 'lib/automation/core/save'
import { Constants } from 'lib/constants/constants'
import { getCharacters } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import { usePrivateScannerState } from 'lib/tabs/tabImport/scannerStore'
import type { HsrOptimizerSaveFormat } from 'types/store'

export { parseSave }

let lastRelics = getRelics()
let lastCharacters = getCharacters()
let revision = 0

/** O(1), evaluated on demand: no idle subscriptions, timers or inventory hashing. */
export function inventoryRevision() {
  const relics = getRelics()
  const characters = getCharacters()
  if (relics !== lastRelics || characters !== lastCharacters) {
    revision++
    lastRelics = relics
    lastCharacters = characters
  }
  return revision
}

export function compareInventory(json: string, offset: number, limit: number) {
  const before = parseSave(json)
  const entries: { kind: string, id: string, change: string, before?: unknown, after?: unknown }[] = []
  const counts = { added: 0, removed: 0, changed: 0 }
  let total = 0
  function compare<T extends { id: string }>(kind: string, old: T[], current: T[], project: (entry: T) => unknown) {
    const remaining = new Map(old.map((entry) => [entry.id, entry]))
    function emit(id: string, change: keyof typeof counts, before?: unknown, after?: unknown) {
      if (total++ >= offset && entries.length < limit) entries.push({ kind, id, change, before, after })
      counts[change]++
    }
    for (const entry of current) {
      const previous = remaining.get(entry.id)
      remaining.delete(entry.id)
      const after = project(entry)
      if (!previous) emit(entry.id, 'added', undefined, after)
      else {
        const before = project(previous)
        if (JSON.stringify(before) !== JSON.stringify(after)) emit(entry.id, 'changed', before, after)
      }
    }
    for (const entry of remaining.values()) emit(entry.id, 'removed', project(entry))
  }
  compare('relic', before.relics, getRelics(), (relic) => ({
    part: relic.part,
    set: relic.set,
    grade: relic.grade,
    enhance: relic.enhance,
    main: { stat: relic.main.stat, value: relic.main.value },
    substats: relic.substats.map(({ stat, value }) => ({ stat, value })).sort((a, b) => a.stat.localeCompare(b.stat)),
    previewSubstats: (relic.previewSubstats ?? []).map(({ stat, value }) => ({ stat, value })),
    equippedBy: relic.equippedBy ?? null,
  }))
  compare('character', before.characters, getCharacters(), (character) => ({
    eidolon: character.form.characterEidolon,
    lightCone: character.form.lightCone,
    superimposition: character.form.lightConeSuperimposition,
    equipped: Object.values(Constants.Parts).map((part) => character.equipped[part] ?? null),
  }))
  const scanner = usePrivateScannerState.getState()
  compare(
    'material',
    before.scannerInventory?.materials ?? [],
    scanner.inventorySource ? Object.values(scanner.materials) : [],
    (material) => ({ name: material.name, count: material.count, expireTime: material.expire_time }),
  )
  const cones = (items: NonNullable<HsrOptimizerSaveFormat['scannerInventory']>['lightCones']) =>
    items.map((cone) => ({ ...cone, id: cone._uid, lightConeId: cone.id }))
  compare(
    'lightCone',
    cones(before.scannerInventory?.lightCones ?? []),
    cones(scanner.inventorySource ? Object.values(scanner.lightCones) : []),
    (cone) => ({ lightConeId: cone.lightConeId, level: cone.level, superimposition: cone.superimposition, location: cone.location }),
  )
  const funds = (gacha: NonNullable<HsrOptimizerSaveFormat['scannerInventory']>['gacha']) =>
    gacha
      ? [{ id: 'stellar_jade', value: gacha.stellar_jade }, { id: 'oneric_shards', value: gacha.oneric_shards }]
      : []
  compare('funds', funds(before.scannerInventory?.gacha ?? null), funds(scanner.inventorySource ? scanner.gachaFunds : null), (fund) => fund.value)
  return { inventoryRevision: inventoryRevision(), total, counts, offset, entries }
}
