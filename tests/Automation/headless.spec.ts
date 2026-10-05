import {
  expect,
  test,
} from '@playwright/test'
import { execFile } from 'node:child_process'
import {
  readFile,
  writeFile,
} from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { HsrOptimizerSaveFormat } from '../../src/types/store'
import { data } from './fixtures'

const exec = promisify(execFile)
const binary = 'output/headless/automation-headless.mjs'

function withoutRevision(value: unknown) {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => key === 'inventoryRevision' ? undefined : item)) as unknown
}

test('Node without browser globals matches browser simulations for every fully equipped sample character', async ({ page }) => {
  await page.goto('')
  await page.waitForFunction(() => !!window.hsrAutomation)
  await data(page, 'import_save', { json: await readFile('src/data/sample-save.json', 'utf8') })
  const snapshot = await data(page, 'export_save') as string
  const save = JSON.parse(snapshot) as HsrOptimizerSaveFormat
  const savePath = test.info().outputPath('save.json')
  await writeFile(savePath, snapshot)
  const guard = test.info().outputPath('no-browser.mjs')
  // Keep browser APIs unavailable and prevent shims; allow feature detection via typeof.
  await writeFile(
    guard,
    `for (const name of ['window','document','localStorage','sessionStorage','navigator','Worker','WebSocket']) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false })
  }`,
  )
  let compared = 0
  for (const character of save.characters.filter((entry) => Object.values(entry.equipped).filter(Boolean).length === 6)) {
    const characterId = character.id
    const relics = Object.values(character.equipped).map((id) => save.relics.find((relic) => relic.id === id)!)
    const request = {
      baseline: { characterId },
      candidates: [
        { characterId, settings: { rotation: ['DEFAULT_SKILL', 'DEFAULT_ULT'] } },
        { characterId, settings: { mainStatUpscaleLevel: 15 } },
        {
          characterId,
          virtualRelics: relics.map((relic) => ({
            part: relic.part,
            set: relic.set,
            grade: relic.grade,
            enhance: relic.enhance,
            mainStat: relic.main.stat,
            substats: relic.substats.map(({ stat, value }) => ({ stat, value })),
          })),
        },
        { characterId, settings: { teammates: [{ characterId: characterId === '1212b1' ? '1005b1' : '1212b1' }, null, null] } },
      ],
    }
    const requestPath = test.info().outputPath(`request-${characterId}.json`)
    await writeFile(requestPath, JSON.stringify(request))
    const expected = withoutRevision(await data(page, 'compare_builds', request))
    const result = await exec(process.execPath, ['--import', pathToFileURL(guard).href, binary, 'compare_builds', savePath, requestPath], { windowsHide: true })
    expect(JSON.parse(result.stdout), characterId).toEqual({ ok: true, data: expected })
    compared += 1 + request.candidates.length
  }
  expect(compared).toBe(25)
  expect(await readFile(savePath, 'utf8')).toBe(snapshot)
})

test('Node preserves saved trace overrides and named build settings', async ({ page }) => {
  await page.goto('')
  await page.waitForFunction(() => !!window.hsrAutomation)
  const source = JSON.parse(await readFile('src/data/sample-save.json', 'utf8')) as HsrOptimizerSaveFormat
  source.scoringMetadataOverrides = {}
  await data(page, 'import_save', { json: JSON.stringify(source) })
  const enabled = await data(page, 'simulate_build', { characterId: '1212b1' })
  source.scoringMetadataOverrides = { '1212b1': { traces: { deactivated: ['11212201'] } } }
  await data(page, 'import_save', { json: JSON.stringify(source) })
  const disabled = await data(page, 'simulate_build', { characterId: '1212b1' })
  expect(enabled.stats.CD - disabled.stats.CD).toBeCloseTo(0.053, 6)
  await data(page, 'save_build', { characterId: '1212b1', name: 'Node comparison', settings: { rotation: ['DEFAULT_SKILL'] } })
  const snapshot = await data(page, 'export_save') as string
  const request = { characterId: '1212b1', buildName: 'Node comparison' }
  const expected = withoutRevision(await data(page, 'simulate_build', request))
  const savePath = test.info().outputPath('traces.json')
  const requestPath = test.info().outputPath('named-build.json')
  await writeFile(savePath, snapshot)
  await writeFile(requestPath, JSON.stringify(request))
  const result = await exec(process.execPath, [binary, 'simulate_build', savePath, requestPath], { windowsHide: true })
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, data: expected })
})

test('Node rejects invalid input with a structured error and nonzero exit', async () => {
  const requestPath = test.info().outputPath('invalid.json')
  await writeFile(requestPath, JSON.stringify({ characterId: 'missing' }))
  const result = await exec(process.execPath, [binary, 'simulate_build', 'src/data/sample-save.json', requestPath], { windowsHide: true })
    .then(() => {
      throw new Error('Invalid character was accepted')
    }, (error: { code: number, stdout: string }) => error)
  expect(result.code).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining('not imported') } })
})
