import {
  expect,
  test,
} from '@playwright/test'
import {
  call,
  character,
  data,
  relics,
  save,
  scan,
  settings,
} from './fixtures'

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await data(page, 'import_save', { json: save })
})

test('saved builds preview conflicts, transfer equipment and expose paged inventory changes', async ({ page }) => {
  const characters = (await data(page, 'list_characters')).characters
  const target = characters.find((entry: { id: string }) => entry.id === character.id)
  const other = characters.find((entry: { id: string }) => entry.id !== character.id)
  const baseline = await data(page, 'export_save')
  const relicIds = Object.values(other.equipped)
  await data(page, 'save_build', { characterId: target.id, name: 'Transferred build', relicIds, settings })
  const assignments = [{ characterId: target.id, name: 'Transferred build' }]
  const plan = await data(page, 'check_builds', { assignments })
  expect(plan.conflicts).toHaveLength(6)
  expect((await call(page, 'equip_builds', { assignments, expectedRevision: plan.inventoryRevision })).error.code).toBe('EQUIPMENT_CONFLICT')
  await data(page, 'equip_builds', { assignments, expectedRevision: plan.inventoryRevision, onConflict: 'transfer' })
  const saved = JSON.parse(await data(page, 'export_save'))
  expect(saved.characters.find((entry: { id: string }) => entry.id === target.id).equipped).toEqual(other.equipped)
  expect(Object.values(saved.characters.find((entry: { id: string }) => entry.id === other.id).equipped)).toEqual([])
  expect(saved.relics.filter((relic: { id: string }) => relicIds.includes(relic.id)).every((relic: { equippedBy: string }) => relic.equippedBy === target.id))
    .toBe(true)
  const diff = await data(page, 'compare_inventory', { json: baseline, limit: 1 })
  expect(diff.entries).toHaveLength(1)
  expect(diff.counts.changed).toBe(14) // Twelve relic owners and two character equipment maps.
  const duplicate = [{ characterId: target.id, relicIds }, { characterId: other.id, relicIds }]
  const conflict = await data(page, 'check_builds', { assignments: duplicate })
  expect(conflict.conflicts.filter((conflict: { type: string }) => conflict.type === 'shared')).toHaveLength(6)
  expect((await call(page, 'equip_builds', { assignments: duplicate, expectedRevision: conflict.inventoryRevision, onConflict: 'transfer' })).error.code).toBe(
    'EQUIPMENT_CONFLICT',
  )
  await data(page, 'delete_build', { characterId: target.id, name: 'Transferred build' })
  expect((await call(page, 'equip_builds', { assignments: [{ characterId: target.id, relicIds }], expectedRevision: conflict.inventoryRevision })).error.code)
    .toBe('STALE_INVENTORY')
})

test('explicit rotations and virtual main stats compare without mutating inventory', async ({ page }) => {
  const before = await data(page, 'export_save')
  const baseline = { characterId: character.id, settings: { ...settings, rotation: ['DEFAULT_SKILL'] } }
  const result = await data(page, 'compare_builds', {
    baseline,
    candidates: [{ ...baseline, settings: { ...baseline.settings, rotation: ['DEFAULT_SKILL', 'DEFAULT_SKILL'] } }],
  })
  expect(result.candidates[0].changes.COMBO.percent).toBeCloseTo(100, 4)
  const ids = new Set(Object.values(character.equipped))
  const virtualRelics = relics.filter((relic) => ids.has(relic.id)).map((relic) => ({
    part: relic.part,
    set: relic.set,
    grade: relic.grade,
    enhance: relic.enhance,
    mainStat: relic.part === 'Body' ? 'HP%' : relic.main.stat,
    substats: relic.substats.map(({ stat, value }) => ({ stat, value })),
  }))
  const virtual = await data(page, 'simulate_build', { ...baseline, virtualRelics })
  expect(virtual.virtual).toBe(true)
  expect(virtual.stats.HP).toBeGreaterThan(result.baseline.stats.HP)
  expect(await data(page, 'export_save')).toBe(before)
})

test('saved builds preserve rotations and teammates without a light cone across export/import', async ({ page }) => {
  const options = { ...settings, rotation: ['DEFAULT_SKILL', 'DEFAULT_ULT'], teammates: [{ characterId: '1101' }, null, null] }
  await data(page, 'save_build', { characterId: character.id, name: 'Rotation test', settings: options })
  const exported = await data(page, 'export_save')
  await data(page, 'import_save', { json: exported })
  const request = await data(page, 'get_request', { characterId: character.id, buildName: 'Rotation test' })
  expect(request.settings.teammates[0].characterId).toBe('1101')
  expect(request.settings.comboTurnAbilities).toEqual(['NULL', 'DEFAULT_SKILL', 'DEFAULT_ULT'])
  const builds = await data(page, 'list_builds', { characterId: character.id })
  expect(builds.builds.find((build: { name: string }) => build.name === 'Rotation test').missingRelics).toEqual([])
})

test('scanner import retains resources and cone inventory after reload; malformed scans do not mutate data', async ({ page }) => {
  expect((await data(page, 'get_resources')).available).toBe(false)
  await data(page, 'import_scan', { json: JSON.stringify(scan) })
  const resources = await data(page, 'get_resources')
  expect(resources.funds.stellar_jade).toBe(1600)
  expect(resources.materials[0].count).toBe(12)
  expect((await data(page, 'list_light_cones', { ownedOnly: true })).lightCones[0].id).toBe('23014')
  const exported = await data(page, 'export_save')
  await page.reload()
  expect((await data(page, 'get_resources')).funds.stellar_jade).toBe(1600)
  const invalid = structuredClone(scan)
  invalid.relics[0].set_id = 'unknown'
  expect((await call(page, 'import_scan', { json: JSON.stringify(invalid) })).error.code).toBe('INVALID_INPUT')
  expect(await data(page, 'export_save')).toBe(exported)
  await data(page, 'import_scan', { json: JSON.stringify(scan) })
  expect((await data(page, 'compare_inventory', { json: exported })).total).toBe(0)
})

test('batch searches retain per-scenario results and produce an applicable joint assignment', async ({ page }) => {
  const characters = (await data(page, 'list_characters')).characters
  const requests = characters.map((entry: { id: string }) => ({ characterId: entry.id, settings }))
  const batch = await data(page, 'start_batch', { requests })
  await expect.poll(async () => (await data(page, 'get_batch', { batchId: batch.batchId })).status, { timeout: 45000 }).toBe('completed')
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex++) {
    const results = await data(page, 'get_batch_results', { batchId: batch.batchId, requestIndex })
    expect(results.total).toBe(1)
    await data(page, 'save_batch_result', { batchId: batch.batchId, requestIndex, index: 0, name: 'Batch candidate' })
  }
  const solution = await data(page, 'allocate_batch', { batchId: batch.batchId })
  expect(solution.searchComplete).toBe(true)
  expect(solution.scope).toBe('retained_candidates')
  expect(solution.assignments).toHaveLength(2)
  const assignments = solution.assignments.map(({ characterId, relicIds }: { characterId: string, relicIds: string[] }) => ({ characterId, relicIds }))
  const plan = await data(page, 'check_builds', { assignments })
  expect(plan.conflicts).toEqual([])
  await data(page, 'equip_builds', { assignments, expectedRevision: plan.inventoryRevision })
})

test('batch cancellation blocks competing mutations and does not start pending scenarios', async ({ page }) => {
  const result = await page.evaluate(async ({ characterId, settings }) => {
    const api = window.hsrAutomation
    const batch = await api.call('start_batch', { requests: [{ characterId, settings }, { characterId, settings }] }) as any
    const start = await api.call('start_optimization', { characterId, settings })
    const save = await api.call('save_build', { characterId, name: 'Blocked' })
    const cancelled = await api.call('cancel_batch', { batchId: batch.data.batchId })
    return { start, save, cancelled }
  }, { characterId: character.id, settings })
  expect(result.start).toMatchObject({ ok: false, error: { code: 'BUSY' } })
  expect(result.save).toMatchObject({ ok: false, error: { code: 'BUSY' } })
  expect(result.cancelled).toMatchObject({ ok: true, data: { status: 'cancelled', scenarios: [{ status: 'cancelled' }, { status: 'not_started' }] } })
  const next = await data(page, 'start_batch', { requests: [{ characterId: character.id, settings }] })
  await expect.poll(async () => (await data(page, 'get_batch', { batchId: next.batchId })).status, { timeout: 45000 }).toBe('completed')
})
