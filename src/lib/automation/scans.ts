import { AutomationError } from 'lib/automation/contracts'
import {
  inventoryRevision,
  parseSave,
} from 'lib/automation/inventory'
import { scanSchema } from 'lib/automation/scanSchemas'
import { validateRelicSlot } from 'lib/automation/simulation'
import { Constants } from 'lib/constants/constants'
import { ScannerSourceToParser } from 'lib/importer/importConfig'
import { type ScannerParserJson } from 'lib/importer/kelzFormatParser'
import {
  loadSaveData,
  mergeRelics,
} from 'lib/services/persistenceService'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { SaveState } from 'lib/state/saveState'
import { getCharacters } from 'lib/stores/character/characterStore'
import { getRelics } from 'lib/stores/relic/relicStore'
import { usePrivateScannerState } from 'lib/tabs/tabImport/scannerStore'

function unique(ids: string[], label: string) {
  if (new Set(ids).size !== ids.length) throw new AutomationError('INVALID_INPUT', `Duplicate ${label} IDs`)
}

export function importScan(json: string) {
  const data = scanSchema.parse(JSON.parse(json))
  if (!Object.hasOwn(ScannerSourceToParser, data.source)) throw new AutomationError('INVALID_INPUT', `Unsupported scanner source: ${data.source}`)
  unique(data.relics.map((relic) => relic._uid), 'relic')
  unique(data.light_cones.map((cone) => cone._uid), 'light cone')
  unique(data.materials.map((material) => material.id), 'material')
  const parser = ScannerSourceToParser[data.source]
  let parsed: ReturnType<typeof parser.parse>
  try {
    parsed = parser.parse(data as ScannerParserJson)
  } catch (error) {
    throw new AutomationError('INVALID_INPUT', error instanceof Error ? error.message : String(error))
  }
  if (parsed.relics.length !== data.relics.length || parsed.characters.length !== data.characters.length || parser.badRollInfo) {
    throw new AutomationError('INVALID_INPUT', 'Scanner data could not be parsed completely; inventory was not changed')
  }
  unique(parsed.characters.map((character) => character.characterId), 'character')
  const metadata = getGameMetadata()
  for (const cone of data.light_cones) {
    if (!Object.hasOwn(metadata.lightCones, cone.id)) throw new AutomationError('INVALID_INPUT', `Unknown light cone: ${cone.id}`)
  }
  for (const character of parsed.characters) {
    if (!Object.hasOwn(metadata.characters, character.characterId)) throw new AutomationError('INVALID_INPUT', `Unknown character: ${character.characterId}`)
    // Match the import UI: the optimizer models level-80 characters and light cones.
    character.characterLevel = 80
    character.lightConeLevel = 80
  }
  for (const relic of parsed.relics) {
    validateRelicSlot(relic, relic.main.stat)
    if (
      relic.enhance > relic.grade * 3 || [...relic.substats, ...relic.previewSubstats]
        .some((stat) => !Object.values(Constants.SubStats).includes(stat.stat) || !Number.isFinite(stat.value))
    ) {
      throw new AutomationError('INVALID_INPUT', `Invalid relic stats: ${relic.id}`)
    }
    // UUID scanner IDs have no numeric age. Let the existing store assign a stable index.
    if (!Number.isFinite(relic.ageIndex)) delete relic.ageIndex
  }
  const previous = SaveState.save()
  try {
    mergeRelics(parsed.relics, parsed.characters)
    usePrivateScannerState.setState({
      inventorySource: data.source,
      gachaFunds: data.gacha ?? null,
      materials: Object.fromEntries(data.materials.map((material) => [material.id, material])),
      lightCones: Object.fromEntries(data.light_cones.map((cone) => [cone._uid, cone])),
    })
    SaveState.save()
  } catch (error) {
    if (previous) loadSaveData(parseSave(previous), false)
    throw error
  }
  return { inventoryRevision: inventoryRevision(), source: data.source, characters: getCharacters().length, relics: getRelics().length }
}
