import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  readFile,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { preview } from 'vite'

const [directory, inputPath] = process.argv.slice(2)
assert.ok(directory && inputPath, 'Usage: node scripts/verify-gpu-search.mts BUILD_DIRECTORY DEFAULT_SAVE.json')
const output = resolve(directory)
const source = JSON.parse(await readFile(inputPath, 'utf8'))
const character = source.characters.find((c: any) => c.id === '1310b1')
assert.ok(character)
const parts = ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope']
const originals = parts.map((part) => source.relics.find((r: any) => r.id === character.equipped[part]))
assert.ok(originals.every(Boolean), 'Reference character must have all six relics')
const settings = {
  rankFilter: false,
  includeEquippedRelics: true,
  keepCurrentRelics: false,
  enhance: 0,
  grade: 2,
  mainBody: [],
  mainFeet: [],
  mainPlanarSphere: [],
  mainLinkRope: [],
  setFilters: { fourPiece: [], twoPieceCombos: [], ornaments: [] },
  resultSort: 'COMBO',
}
const report: any = {
  timestamp: new Date().toISOString(),
  notes: [
    'Synthetic small inventories derived from equipped relics; independent exhaustive simulate_build reference.',
    'Checks sorted score multiset within 1e-5, unique feasible IDs, and number of results. Does not prescribe ordering among tied scores.',
  ],
  cases: [],
}
const server = await preview({
  configFile: 'vite.config.ts',
  build: { outDir: `${output}/site` },
  preview: { host: '127.0.0.1', port: 4175, strictPort: true, open: false },
})
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:4175/hsr-optimizer/')
  await page.waitForFunction(() => !!window.hsrAutomation && !!(window as any).__defaultBenchmark)
  for (const kind of ['gradient', 'ties']) {
    const groups = originals.map((original: any, slot: number) =>
      Array.from({ length: 5 }, (_, i) => ({
        ...original,
        id: `verify-${slot}-${i}`,
        equippedBy: undefined,
        substats: original.substats.map((stat: any) => ({ ...stat, value: stat.value + (kind === 'ties' ? 0 : i * (slot + 1) * 0.13) })),
      }))
    )
    const save = JSON.stringify({
      ...source,
      relics: groups.flat(),
      characters: [{ ...character, equipped: {}, builds: [], form: { ...character.form, ...settings, relicSets: [], ornamentSets: [] } }],
    })
    const imported = await page.evaluate((json) => window.hsrAutomation.call('import_save', { json }), save) as any
    assert.ok(imported.ok, JSON.stringify(imported))
    const oracle = await page.evaluate(async ({ characterId, groups, settings }) => {
      const scores: number[] = []
      for (let index = 0; index < 5 ** 6; index++) {
        let rest = index
        const relicIds = groups.map((ids: string[]) => {
          const id = ids[rest % 5]
          rest = Math.floor(rest / 5)
          return id
        })
        const response = await window.hsrAutomation.call('simulate_build', { characterId, relicIds, settings }) as any
        if (!response.ok) throw Error(JSON.stringify(response))
        const score = response.data.stats.COMBO
        if (!Number.isFinite(score)) throw Error('Non-finite reference score')
        scores.push(score)
        if (index % 256 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      }
      return scores.sort((a, b) => b - a)
    }, { characterId: character.id, groups: groups.map((group) => group.map((r: any) => r.id)), settings })
    for (const limit of [1, 10, 100, 1024]) {
      const start = await page.evaluate(async ({ characterId, settings, limit }) =>
        limit === 1024
          ? { ok: true, data: (window as any).__defaultBenchmark.start(characterId) }
          : window.hsrAutomation.call('start_optimization', { characterId, settings: { ...settings, resultsLimit: limit }, engine: 'gpu' }), {
        characterId: character.id,
        settings,
        limit,
      }) as any
      assert.ok(start.ok, JSON.stringify(start))
      const jobId = start.data.jobId
      const deadline = performance.now() + 120000
      let status: any
      for (;;) {
        status = await page.evaluate((jobId) => window.hsrAutomation.call('get_job', { jobId }), jobId)
        assert.ok(status.ok, JSON.stringify(status))
        if (status.data.status !== 'running') break
        assert.ok(performance.now() < deadline, 'GPU search exceeded verification timeout')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.equal(status.data.status, 'completed', JSON.stringify(status))
      assert.equal(status.data.permutations, 5 ** 6)
      assert.equal(status.data.resultCount, limit)
      const results: any[] = []
      for (let offset = 0; offset < limit; offset += 100) {
        const response = await page.evaluate(({ jobId, offset }) => window.hsrAutomation.call('get_results', { jobId, offset, limit: 100 }), {
          jobId,
          offset,
        }) as any
        assert.ok(response.ok)
        results.push(...response.data.results)
      }
      const ids = results.map((row) => parts.map((part) => row.relics[part]).join('/'))
      assert.equal(new Set(ids).size, limit)
      for (const row of results) for (let slot = 0; slot < 6; slot++) assert.ok(groups[slot].some((r: any) => r.id === row.relics[parts[slot]]))
      const scores = results.map((row) => row.stats.COMBO).sort((a, b) => b - a)
      let maxRelativeError = 0
      for (let i = 0; i < limit; i++) maxRelativeError = Math.max(maxRelativeError, Math.abs(scores[i] - oracle[i]) / Math.max(1, Math.abs(oracle[i])))
      assert.ok(maxRelativeError < 1e-5, `${kind}/${limit}: ${maxRelativeError}`)
      report.cases.push({
        kind,
        limit,
        permutations: 5 ** 6,
        verified: results.length,
        maxRelativeError,
        inputSha256: createHash('sha256').update(save).digest('hex'),
        scores,
      })
      await writeFile(`${output}/oracle-report.json`, JSON.stringify(report, null, 2))
      process.stdout.write(`${kind}/${limit}: exhaustive reference passed, relative error ${maxRelativeError}\n`)
    }
  }
  assert.deepEqual(errors, [])
  report.pageErrors = errors
} finally {
  await writeFile(`${output}/oracle-report.json`, JSON.stringify(report, null, 2))
  await browser.close()
  await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()))
}
