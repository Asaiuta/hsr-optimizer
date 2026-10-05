import {
  expect,
  type Page,
  test,
} from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { AutomationApi } from '../../src/lib/automation/install'

const source = JSON.parse(readFileSync(new URL('../../src/data/sample-save.json', import.meta.url), 'utf8'))
const character = source.characters.find((entry: { id: string }) => entry.id === '1212b1')
const equipped = new Set(Object.values(character.equipped))
const relics = source.relics.filter((entry: { id: string }) => equipped.has(entry.id))
const save = JSON.stringify({ characters: [character], relics })
const settings = {
  keepCurrentRelics: true,
  rankFilter: false,
  enhance: 0,
  mainBody: [],
  mainFeet: [],
  mainPlanarSphere: [],
  mainLinkRope: [],
  setFilters: { fourPiece: [], twoPieceCombos: [], ornaments: [] },
}

async function call(page: Page, name: string, input: unknown = {}): Promise<any> {
  return page.evaluate(({ name, input }) => (window as Window & { hsrAutomation: AutomationApi }).hsrAutomation.call(name, input), { name, input })
}

async function completed(page: Page, jobId: string) {
  await expect.poll(async () => (await call(page, 'get_job', { jobId })).data?.status, { timeout: 45000 }).not.toBe('running')
  const status = await call(page, 'get_job', { jobId })
  expect(status.data.status, JSON.stringify(status)).toBe('completed')
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  const imported = await call(page, 'import_save', { json: save })
  expect(imported, JSON.stringify(imported)).toMatchObject({ ok: true, data: { characters: 1, relics: 6 } })
})

test('CPU search, simulation, pagination and named save use the same six relics', async ({ page }) => {
  const before = await call(page, 'export_save')
  const simulation = await call(page, 'simulate_build', { characterId: '1212b1', settings })
  expect(simulation.ok, JSON.stringify(simulation)).toBe(true)
  const started = await call(page, 'start_optimization', { characterId: '1212b1', settings })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  const jobId = started.data.jobId
  await completed(page, jobId)
  const results = await call(page, 'get_results', { jobId, limit: 1 })
  expect(results.data.resultCount).toBe(1)
  expect(Object.values(results.data.results[0].relics).sort()).toEqual([...equipped].sort())
  expect(results.data.results[0].stats.COMBO).toBeCloseTo(simulation.data.stats.COMBO, 1)
  expect((await call(page, 'get_results', { jobId, offset: 1 })).data.results).toEqual([])
  expect((await call(page, 'save_result', { jobId, index: 0, name: 'AI verification' })).ok).toBe(true)
  expect((await call(page, 'save_result', { jobId, index: 0, name: 'AI verification' })).error.code).toBe('ALREADY_EXISTS')
  const after = JSON.parse((await call(page, 'export_save')).data)
  expect(after.characters[0].equipped).toEqual(JSON.parse(before.data).characters[0].equipped)
  expect(after.characters[0].builds.at(-1).name).toBe('AI verification')
})

test('concurrent submission and cancellation have explicit outcomes', async ({ page }) => {
  const responses = await page.evaluate(async (settings) => {
    const api = (window as Window & { hsrAutomation: AutomationApi }).hsrAutomation
    const first = await api.call('start_optimization', { characterId: '1212b1', settings }) as any
    const second = await api.call('start_optimization', { characterId: '1212b1', settings })
    const cancel = await api.call('cancel_job', { jobId: first.data.jobId })
    return { first, second, cancel }
  }, settings)
  expect(responses.second).toMatchObject({ ok: false, error: { code: 'BUSY' } })
  expect(responses.cancel).toMatchObject({ ok: true, data: { status: 'cancelled' } })
  expect((await call(page, 'get_results', { jobId: responses.first.data.jobId })).error.code).toBe('NOT_COMPLETED')
  const next = await call(page, 'start_optimization', { characterId: '1212b1', settings })
  await completed(page, next.data.jobId)
  expect((await call(page, 'cancel_job', { jobId: responses.first.data.jobId })).error.code).toBe('NOT_FOUND')
})

test('empty results and stale inventory cannot become a saved optimum', async ({ page }) => {
  const empty = await call(page, 'start_optimization', { characterId: '1212b1', settings: { ...settings, statFilters: { minSpd: 10000 } } })
  await completed(page, empty.data.jobId)
  expect((await call(page, 'get_results', { jobId: empty.data.jobId })).data.resultCount).toBe(0)
  const next = await call(page, 'start_optimization', { characterId: '1212b1', settings })
  await completed(page, next.data.jobId)
  await call(page, 'import_save', { json: save })
  expect((await call(page, 'save_result', { jobId: next.data.jobId, index: 0, name: 'stale' })).error.code).toBe('STALE_INVENTORY')
})

test('invalid imports and filters leave existing data intact', async ({ page }) => {
  const before = (await call(page, 'export_save')).data
  expect((await call(page, 'import_save', { json: '{"relics":[{}],"characters":[]}' })).error.code).toBe('INVALID_INPUT')
  expect((await call(page, 'export_save')).data).toBe(before)
  expect((await call(page, 'get_request', { characterId: '1212b1', settings: { statFilters: { minSpd: 140, maxSpd: 120 } } })).error.code).toBe('INVALID_INPUT')
  expect((await call(page, 'list_relics', { limit: 1000 })).error.code).toBe('INVALID_INPUT')
})

test('GPU publishes results before completion, matching the single-build CPU simulation', async ({ page }) => {
  const available = await page.evaluate(async () => !!await navigator.gpu?.requestAdapter())
  test.skip(!available, 'WebGPU adapter unavailable on this host')
  const simulation = await call(page, 'simulate_build', { characterId: '1212b1', settings })
  const started = await call(page, 'start_optimization', { characterId: '1212b1', settings, engine: 'gpu' })
  await completed(page, started.data.jobId)
  const results = await call(page, 'get_results', { jobId: started.data.jobId })
  expect(results.data.resultCount).toBe(1)
  expect(results.data.results[0].stats.COMBO).toBeCloseTo(simulation.data.stats.COMBO, 1)
})

test('GPU cancellation and empty results allow a subsequent search', async ({ page }) => {
  test.skip(!await page.evaluate(async () => !!await navigator.gpu?.requestAdapter()), 'WebGPU adapter unavailable on this host')
  const cancelled = await page.evaluate(async (settings) => {
    const started = await window.hsrAutomation.call('start_optimization', { characterId: '1212b1', settings, engine: 'gpu' }) as any
    if (!started.ok) throw Error(JSON.stringify(started))
    return window.hsrAutomation.call('cancel_job', { jobId: started.data.jobId })
  }, settings)
  expect(cancelled).toMatchObject({ ok: true, data: { status: 'cancelled' } })

  const empty = await call(page, 'start_optimization', {
    characterId: '1212b1',
    settings: { ...settings, statFilters: { minSpd: 10000 } },
    engine: 'gpu',
  })
  await completed(page, empty.data.jobId)
  expect((await call(page, 'get_results', { jobId: empty.data.jobId })).data.resultCount).toBe(0)
  const next = await call(page, 'start_optimization', { characterId: '1212b1', settings, engine: 'gpu' })
  await completed(page, next.data.jobId)
  expect((await call(page, 'get_results', { jobId: next.data.jobId })).data.resultCount).toBe(1)
})

for (const engine of ['cpu', 'gpu', 'gpu-tuple']) {
  test(`${engine} ranks the best seven of 64 builds like exhaustive single-build simulation`, async ({ page }) => {
    if (engine !== 'cpu') {
      test.skip(!await page.evaluate(async () => !!await navigator.gpu?.requestAdapter()), 'WebGPU adapter unavailable on this host')
    }
    const alternatives = relics.map((relic: any, index: number) => ({
      ...relic,
      id: `${relic.id}-alternative`,
      equippedBy: undefined,
      substats: relic.substats.map((stat: { stat: string, value: number }) => ({
        ...stat,
        value: stat.value + (stat.stat === (relic.part === 'Body' ? 'ATK%' : 'CRIT DMG') ? 0.5 * 2 ** index : 0),
      })),
    }))
    expect((await call(page, 'import_save', { json: JSON.stringify({ characters: [character], relics: [...relics, ...alternatives] }) })).ok).toBe(true)
    const options = {
      ...settings,
      keepCurrentRelics: false,
      includeEquippedRelics: true,
      resultsLimit: 7,
      resultSort: 'COMBO',
      ...(engine === 'gpu-tuple'
        ? {
          setFilters: {
            fourPiece: [relics.find((relic: any) => relic.part === 'Head').set],
            twoPieceCombos: [],
            ornaments: [relics.find((relic: any) => relic.part === 'LinkRope').set],
          },
        }
        : {}),
    }
    const combinations = Array.from(
      { length: 64 },
      (_, mask) => relics.map((relic: any, index: number) => mask & (1 << index) ? alternatives[index].id : relic.id),
    )
    const simulated = await page.evaluate(async ({ combinations, options }) => {
      const results = []
      for (const relicIds of combinations) {
        results.push(await window.hsrAutomation.call('simulate_build', { characterId: '1212b1', settings: options, relicIds }))
      }
      return results
    }, { combinations, options }) as any[]
    expect(simulated.every((result) => result.ok)).toBe(true)
    const expected = simulated.map((result) => result.data).sort((a, b) => b.stats.COMBO - a.stats.COMBO).slice(0, 7)
    const buildKey = (ids: string[]) => ids.sort().join(',')
    const byBuild = new Map(simulated.map((result) => [buildKey(result.data.relicIds), result.data]))
    const started = await call(page, 'start_optimization', { characterId: '1212b1', settings: options, engine: engine === 'cpu' ? 'cpu' : 'gpu' })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    await completed(page, started.data.jobId)
    const results = await call(page, 'get_results', { jobId: started.data.jobId })
    expect(results.data.permutations).toBe(64)
    expect(results.data.resultCount).toBe(7)
    const seen = new Set<string>()
    for (const [index, result] of results.data.results.entries()) {
      const key = buildKey(Object.values(result.relics))
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      const matching = byBuild.get(key)
      expect(matching).toBeDefined()
      expect(Math.abs(result.stats.COMBO / matching.stats.COMBO - 1)).toBeLessThan(1e-5)
      expect(result.stats.ATK).toBeCloseTo(matching.stats.ATK, 2)
      // Equally scoring builds can occur in a different order on each engine.
      expect(Math.abs(result.stats.COMBO / expected[index].stats.COMBO - 1)).toBeLessThan(1e-5)
    }
  })
}

test('single-build simulation applies the same predicted main stat upgrade as a search', async ({ page }) => {
  const unenhanced = relics.map((relic: any) => relic.part === 'Head' ? { ...relic, enhance: 0 } : relic)
  expect((await call(page, 'import_save', { json: JSON.stringify({ characters: [character], relics: unenhanced }) })).ok).toBe(true)
  const options = { ...settings, mainStatUpscaleLevel: 15 }
  const current = await call(page, 'simulate_build', { characterId: '1212b1', settings: { ...options, mainStatUpscaleLevel: 0 } })
  const predicted = await call(page, 'simulate_build', { characterId: '1212b1', settings: options })
  expect(predicted.data.stats.HP).toBeGreaterThan(current.data.stats.HP)
  const started = await call(page, 'start_optimization', { characterId: '1212b1', settings: options })
  await completed(page, started.data.jobId)
  const results = await call(page, 'get_results', { jobId: started.data.jobId })
  expect(results.data.resultCount).toBe(1)
  expect(results.data.results[0].stats.HP).toBeCloseTo(predicted.data.stats.HP, 2)
})
