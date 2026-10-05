import { AutomationError } from 'lib/automation/contracts'
import { scannerInventorySchema } from 'lib/automation/scanSchemas'
import { Constants } from 'lib/constants/constants'
import { getGameMetadata } from 'lib/state/gameMetadata'
import type { HsrOptimizerSaveFormat } from 'types/store'
import { z } from 'zod'

const stat = z.looseObject({ stat: z.enum(Constants.MainStats), value: z.number().finite().nonnegative() })
const substat = stat.extend({ stat: z.enum(Object.values(Constants.SubStats)) })
const saveSchema = z.looseObject({
  scannerInventory: scannerInventorySchema.optional(),
  relics: z.array(z.looseObject({
    id: z.string().min(1),
    part: z.enum(Object.values(Constants.Parts)),
    set: z.enum(Object.values(Constants.Sets)),
    grade: z.int().min(2).max(5),
    enhance: z.int().min(0).max(15),
    main: stat,
    substats: z.array(substat).max(4),
    previewSubstats: z.array(substat).max(4).optional(),
  })).max(10000),
  characters: z.array(z.looseObject({
    id: z.string().min(1),
    equipped: z.record(z.string(), z.string().optional()),
    form: z.looseObject({ characterId: z.string().min(1), characterEidolon: z.int().min(0).max(6) }),
  })).max(200),
})

export function parseSave(json: string): HsrOptimizerSaveFormat {
  const save = saveSchema.parse(JSON.parse(json))
  const metadata = getGameMetadata()
  const ids = new Set<string>()
  for (const relic of save.relics) {
    if (ids.has(relic.id)) throw new AutomationError('INVALID_INPUT', `Duplicate relic ID: ${relic.id}`)
    ids.add(relic.id)
  }
  ids.clear()
  for (const character of save.characters) {
    if (ids.has(character.id) || character.form.characterId !== character.id || !Object.hasOwn(metadata.characters, character.id)) {
      throw new AutomationError('INVALID_INPUT', `Invalid or duplicate character: ${character.id}`)
    }
    ids.add(character.id)
  }
  return save as unknown as HsrOptimizerSaveFormat
}
