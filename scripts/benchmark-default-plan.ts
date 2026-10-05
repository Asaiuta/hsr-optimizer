import { resolveRequest } from 'lib/automation/core/request'
import { parseSave } from 'lib/automation/core/save'
import { getDefaultForm } from 'lib/optimization/defaultForm'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import { RelicFilters } from 'lib/relics/relicFilters'
import { getGameMetadata } from 'lib/state/gameMetadata'
import { Metadata } from 'lib/state/metadataInitializer'
import { useCharacterStore } from 'lib/stores/character/characterStore'
import { useRelicStore } from 'lib/stores/relic/relicStore'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { CharacterId } from 'types/character'

const [input, output] = process.argv.slice(2)
assert.ok(input && output)
mkdirSync(output, { recursive: true })
Metadata.initialize()
const original = readFileSync(input, 'utf8')
const save = parseSave(original)
save.characters = save.characters.map((character) => ({
  ...character,
  form: {
    ...getDefaultForm({ id: character.id }),
    characterEidolon: character.form.characterEidolon,
    characterLevel: character.form.characterLevel,
    lightCone: character.form.lightCone,
    lightConeLevel: character.form.lightConeLevel,
    lightConeSuperimposition: character.form.lightConeSuperimposition,
  },
}))
assert.ok(save.savedSession, 'Benchmark input must include savedSession')
save.savedSession.global.computeEngine = 'GPU Stable'
// Keep source order: rankFilter protects gear on characters before the requested character.
useCharacterStore.getState().setCharacters(save.characters)
useRelicStore.getState().setRelics(structuredClone(save.relics).map((relic) => RelicAugmenter.augment(relic)!))
const plans = save.characters.map((character, rank) => {
  const name = getGameMetadata().characters[character.id as CharacterId].name
  try {
    // The automation bridge defaults resultsLimit to 10; explicitly restore the original 1024.
    const { state, form } = resolveRequest({ characterId: character.id, settings: { resultsLimit: 1024 } }, save.characters)
    assert.equal(form.enhance, 9)
    assert.equal(form.grade, 5)
    assert.equal(form.rankFilter, true)
    assert.equal(form.includeEquippedRelics, true)
    assert.equal(form.keepCurrentRelics, false)
    assert.equal(form.resultsLimit, 1024)
    assert.equal(form.mainStatUpscaleLevel, 15)
    assert.equal(form.relicSets?.length ?? 0, 0)
    assert.equal(form.ornamentSets?.length ?? 0, 0)
    const start = performance.now()
    const { counts, preCounts } = RelicFilters.getFilteredRelicCounts(form)
    return {
      characterId: character.id,
      name,
      rank,
      countMs: performance.now() - start,
      counts,
      preCounts,
      permutations: Object.values(counts).reduce((a, b) => a * b, 1),
      resolved: state,
    }
  } catch (error) {
    return { characterId: character.id, name, rank, unavailable: String(error) }
  }
})
const serialized = JSON.stringify(save)
writeFileSync(join(output, 'default-save.json'), serialized)
writeFileSync(
  join(output, 'plan.json'),
  JSON.stringify(
    {
      originalSha256: createHash('sha256').update(original).digest('hex'),
      defaultSaveSha256: createHash('sha256').update(serialized).digest('hex'),
      notes: [
        'Original getDefaultForm; only scanned identity/eidolon/light cone retained. Gear, inventory and character order unchanged.',
        'No set constraints, so valid permutation count equals the product of filtered slot counts. Count-only; no search run.',
      ],
      plans,
    },
    null,
    2,
  ),
)
process.stdout.write(
  JSON.stringify(plans.map(({ characterId, name, permutations, unavailable }) => ({ characterId, name, permutations, unavailable })), null, 2),
)
