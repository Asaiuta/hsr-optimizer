import {
  expect,
  test,
} from '@playwright/test'
import {
  character,
  data,
  relics,
  settings,
} from './fixtures'

const equipped = new Set(Object.values(character.equipped))
const originals = relics.filter((relic) => equipped.has(relic.id))
const alternatives = originals.map((relic, index) => ({
  ...relic,
  id: `${relic.id}-objective`,
  equippedBy: undefined,
  substats: relic.substats.map((stat) => ({ ...stat, value: stat.value + (index + 1) * 0.37 })),
}))
const combinations = Array.from({ length: 64 }, (_, mask) => originals.map((r, i) => mask & (1 << i) ? alternatives[i].id : r.id))
const buildKey = (ids: string[]) => [...ids].sort().join('/')

const cases = [
  { objective: 'ATK', display: 'base', column: 'ATK' },
  { objective: 'CD', display: 'combat', column: 'xCD', filter: 'ULT' },
  { objective: 'EHP', display: 'combat', column: 'EHP', filter: 'ULT' },
  { objective: 'BASIC', display: 'combat', column: 'BASIC', filter: 'EHP' },
  { objective: 'BASIC', display: 'base', column: 'BASIC', filter: 'ULT' },
  { objective: 'COMBO', display: 'combat', column: 'COMBO' },
  { objective: 'COMBO_HEAL', display: 'combat', column: 'COMBO_HEAL' },
  { objective: 'COMBO_SHIELD', display: 'combat', column: 'COMBO_SHIELD' },
  { objective: 'COMBO_BUFF', display: 'combat', column: 'COMBO_BUFF' },
  { objective: 'CD', display: 'combat', column: 'mxCD', memo: true },
  { objective: 'EHP', display: 'combat', column: 'mxEHP', memo: true },
] as const

export function testObjectives(engine: 'cpu' | 'gpu') {
  for (const spec of cases) {
    const memo = 'memo' in spec && spec.memo
    const filter = 'filter' in spec ? spec.filter : undefined
    test(`${engine} ${memo ? 'memo ' : ''}${spec.display} ${spec.objective}, filter ${filter ?? 'none'} matches exhaustive results`, async ({ page }) => {
      await page.goto('./')
      if (engine === 'gpu') test.skip(!await page.evaluate(async () => !!await navigator.gpu?.requestAdapter()), 'WebGPU adapter unavailable')
      const subject = memo
        ? {
          ...character,
          id: '8008',
          equipped: {},
          form: {
            ...character.form,
            characterId: '8008',
            lightCone: '21051',
            characterConditionals: {},
            lightConeConditionals: {},
            memoDisplay: 'memo',
            comboStateJson: '{}',
          },
        }
        : character
      await data(page, 'import_save', {
        json: JSON.stringify({ characters: [subject], relics: [...originals, ...alternatives].map((r) => ({ ...r, equippedBy: undefined })) }),
      })
      const options = {
        ...settings,
        keepCurrentRelics: false,
        resultSort: spec.objective,
        statDisplay: spec.display,
        resultsLimit: 7,
        rotation: ['DEFAULT_BASIC', 'DEFAULT_SKILL', 'DEFAULT_ULT'],
      }
      const simulated = await page.evaluate(async ({ characterId, combinations, options }) => {
        const rows: { relicIds: string[], stats: Record<string, number> }[] = []
        for (const relicIds of combinations) {
          const response = await window.hsrAutomation.call('simulate_build', { characterId, relicIds, settings: options })
          if (!response.ok) throw Error(JSON.stringify(response))
          rows.push(response.data as typeof rows[number])
        }
        return rows
      }, { characterId: subject.id, combinations, options })
      const filterValues = filter ? [...new Set(simulated.map((r) => r.stats[filter]))].sort((a, b) => a - b) : []
      const midpoint = Math.floor(filterValues.length / 2)
      // Saved UI filters round decimals; use an integer strictly inside the gap.
      const bound = filter ? Math.floor((filterValues[midpoint - 1] + filterValues[midpoint]) / 2) : undefined
      const filterKey = filter === 'ULT' ? 'minUlt' : 'minEhp'
      if (filter) {
        expect(bound!).toBeGreaterThan(filterValues[midpoint - 1])
        expect(bound!).toBeLessThan(filterValues[midpoint])
        // Rating/EHP bounds are supported by saved UI forms, but are not exposed by
        // the automation settings schema. Exercise those existing saved-form inputs.
        const filtered = { ...subject, form: { ...subject.form, [filterKey]: bound } }
        await data(page, 'import_save', {
          json: JSON.stringify({ characters: [filtered], relics: [...originals, ...alternatives].map((r) => ({ ...r, equippedBy: undefined })) }),
        })
        const resolved = await data(page, 'get_request', { characterId: subject.id, settings: options })
        expect(resolved.settings.ratingFilters[filterKey]).toBe(bound)
      }
      const selected = filter ? simulated.filter((r) => r.stats[filter] >= bound!) : simulated
      if (filter) {
        expect(selected.length).toBeGreaterThanOrEqual(7)
        expect(selected.length).toBeLessThan(simulated.length)
      }
      const expected = selected.map((r) => r.stats[spec.column]).sort((a, b) => b - a).slice(0, 7)
      const byIds = new Map(simulated.map((r) => [buildKey(r.relicIds), r.stats]))
      const started = await data(page, 'start_optimization', {
        characterId: subject.id,
        settings: options,
        engine,
      })
      await expect.poll(async () => (await data(page, 'get_job', { jobId: started.jobId })).status, { timeout: 45000 }).not.toBe('running')
      const status = await data(page, 'get_job', { jobId: started.jobId })
      expect(status.status, JSON.stringify(status)).toBe('completed')
      expect(status.permutations).toBe(64)
      const { results } = await data(page, 'get_results', { jobId: started.jobId }) as {
        results: { relics: Record<string, string>, stats: Record<string, number> }[],
      }
      expect(results).toHaveLength(7)
      expect(new Set(results.map((r) => buildKey(Object.values(r.relics)))).size).toBe(7)
      const scores = results.map((r) => r.stats[spec.column]).sort((a, b) => b - a)
      for (let i = 0; i < scores.length; i++) expect(Math.abs(scores[i] - expected[i]) / Math.max(1, Math.abs(expected[i]))).toBeLessThan(1e-5)
      for (const result of results) {
        const reference = byIds.get(buildKey(Object.values(result.relics)))!
        expect(reference).toBeDefined()
        if (filter) expect(result.stats[filter] + Math.abs(bound!) * 1e-5).toBeGreaterThanOrEqual(bound!)
        // Retained rows must still expose complete simulation outputs after pruning.
        for (const [key, value] of Object.entries(reference)) {
          if (key === 'id' || key === 'WEIGHT') continue
          // Legacy CPU rows contain zero memo placeholders when no memo exists.
          if (engine === 'cpu' && !memo && key.startsWith('m')) continue
          expect(Math.abs(result.stats[key] - value) / Math.max(1, Math.abs(value)), key).toBeLessThan(1e-5)
        }
      }
    })
  }
}
