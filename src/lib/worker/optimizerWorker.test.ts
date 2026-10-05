// @vitest-environment jsdom
import sample from 'data/sample-save.json'
import { resolveRequest } from 'lib/automation/core/request'
import { Constants, RelicSetFilterOptions } from 'lib/constants/constants'
import { FixedSizeNumericMinQueue } from 'lib/dataStructures/fixedSizeMinQueue'
import type { RelicsByPart } from 'lib/gpu/webgpuTypes'
import { BasicKey } from 'lib/optimization/basicStatsArray'
import { BufferPacker } from 'lib/optimization/bufferPacker'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { getCpuActionPlan } from 'lib/optimization/cpuActionPlan'
import { createCpuResultRows } from 'lib/optimization/cpuResultRows'
import { GlobalRegister } from 'lib/optimization/engine/config/keys'
import { ComputedStatsContainer } from 'lib/optimization/engine/container/computedStatsContainer'
import * as damageCalculator from 'lib/optimization/engine/damage/damageCalculator'
import { formatOptimizerDisplayData } from 'lib/optimization/optimizerDisplayData'
import {
  generateOrnamentSetSolutions,
  generateRelicSetSolutions,
} from 'lib/optimization/relicSetSolver'
import {
  createResultTieOrder,
  OptimizerResultQueue,
  RESULT_PARTS,
} from 'lib/optimization/resultTieOrder'
import { ComboType } from 'lib/optimization/rotation/comboType'
import { SortOption } from 'lib/optimization/sortOptions'
import { bitpackBooleanArray } from 'lib/optimization/setSolutionBitset'
import { RelicAugmenter } from 'lib/relics/relicAugmenter'
import { RelicFilters } from 'lib/relics/relicFilters'
import {
  SetsOrnaments,
  SetsRelics,
} from 'lib/sets/setConfigRegistry'
import { initializeContextConditionals } from 'lib/simulations/contextConditionals'
import { simulateBuild } from 'lib/simulations/simulateBuild'
import { generateFullDefaultForm } from 'lib/simulations/utils/benchmarkForm'
import { Metadata } from 'lib/state/metadataInitializer'
import { normalizeForm } from 'lib/stores/optimizerForm/optimizerFormConversions'
import {
  optimizerWorker,
  type OptimizerWorkerInput,
  type OptimizerWorkerResult,
} from 'lib/worker/optimizerWorker'
import { prepareOptimizerWorkerRelics } from 'lib/worker/optimizerWorkerRelics'
import { WorkerType } from 'lib/worker/workerUtils'
import type { Form } from 'types/form'
import type { HsrOptimizerSaveFormat } from 'types/store'
import {
  afterEach,
  expect,
  it,
  vi,
} from 'vitest'

Metadata.initialize()
const saved = sample as unknown as HsrOptimizerSaveFormat
const character = saved.characters.find((c) => c.id === '1212b1')!
const ids = new Set(Object.values(character.equipped))
const originals = saved.relics.filter((r) => ids.has(r.id))
const allSets = (count: number) => Array.from({ length: Math.ceil(count / 32) }, () => 0xffffffff)

it.each([
  { resultSort: 'COMBO', minEhp: undefined, maxEhp: undefined, trace: false, calls: 0 },
  { resultSort: 'BASIC', minEhp: 0, maxEhp: Constants.MAX_INT, trace: false, calls: 0 },
  { resultSort: 'EHP', minEhp: undefined, maxEhp: undefined, trace: false, calls: 1 },
  { resultSort: 'BASIC', minEhp: 1, maxEhp: undefined, trace: false, calls: 1 },
  { resultSort: 'BASIC', minEhp: undefined, maxEhp: Constants.MAX_INT, trace: false, calls: 1 },
  { resultSort: 'COMBO', minEhp: undefined, maxEhp: undefined, trace: true, calls: 1 },
] as const)('EHP consumers $resultSort/$minEhp/$maxEhp/trace=$trace', ({ calls, ...patch }) => {
  const { form, relics } = fixture(patch)
  const spy = vi.spyOn(damageCalculator, 'calculateEhp')
  const result = run(form, relics, 0, 1)
  expect(result.length).toBe(2)
  // The fixture checks both full and compact Worker payloads.
  expect(spy).toHaveBeenCalledTimes(calls * 2)
})

it('loaded BASIC request omits later default actions and matches full simulation', () => {
  const { form, relics } = fixture({ resultSort: 'BASIC', resultsLimit: 64 })
  const context = generateContext(form)
  const plan = getCpuActionPlan(form, context)
  expect(plan.defaultActionCount).toBeLessThan(context.defaultActions.length)
  const oracle = fullRows(form, relics)
  const result = run(form, relics, 0, 64)
  expect(result.length).toBe(128)
  for (let i = 0; i < result.length; i += 2) expect(result[i + 1]).toBe(oracle[result[i]].BASIC)
})

function fixture(patch: Partial<Form> = {}, ties = false) {
  const subject = patch.characterId ? { ...character, id: patch.characterId, form: { ...character.form, ...patch } } : character
  const { form } = resolveRequest({ characterId: subject.id, settings: { resultsLimit: 7, resultSort: 'COMBO', statFilters: { minSpd: null } } }, [subject])
  Object.assign(form, patch)
  const relics = RelicFilters.splitRelicsByPart(originals.flatMap((r, i) =>
    [0, 1].map((variant) =>
      RelicAugmenter.augment({
        ...structuredClone(r),
        id: `${r.id}-${variant}`,
        substats: r.substats.map((s) => ({ ...s, value: s.value + (ties ? 0 : variant * (i + 1) * 0.37) })),
      })!
    )
  ))
  RelicFilters.condenseRelicSubstatsForOptimizer(relics)
  return { form, relics }
}

function run(
  form: Form,
  relics: RelicsByPart,
  skip: number,
  width: number,
  permutations = 64,
  setSolutions?: Pick<OptimizerWorkerInput, 'relicSetSolutions' | 'ornamentSetSolutions'>,
) {
  const post = vi.spyOn(self, 'postMessage').mockImplementation(() => {})
  const input: OptimizerWorkerInput = {
    workerType: WorkerType.OPTIMIZER,
    context: JSON.parse(JSON.stringify(generateContext(form))),
    request: form,
    relics,
    WIDTH: width,
    skip,
    permutations,
    relicSetSolutions: allSets(Object.keys(SetsRelics).length ** 4),
    ornamentSetSolutions: allSets(Object.keys(SetsOrnaments).length ** 2),
    ...setSolutions,
  }
  optimizerWorker({ data: structuredClone(input) } as MessageEvent<OptimizerWorkerInput>)
  const full = post.mock.calls.at(-1)![0] as OptimizerWorkerResult
  const compact: OptimizerWorkerInput = {
    ...input,
    relics: prepareOptimizerWorkerRelics(relics),
    relicSetSolutions: Uint32Array.from(input.relicSetSolutions),
    ornamentSetSolutions: Uint32Array.from(input.ornamentSetSolutions),
  }
  optimizerWorker({ data: structuredClone(compact) } as MessageEvent<OptimizerWorkerInput>)
  const result = post.mock.calls.at(-1)![0] as OptimizerWorkerResult
  expect(result.candidates).toEqual(full.candidates)
  expect(result.candidates.byteLength).toBeLessThanOrEqual((form.resultsLimit ?? 1024) * 16)
  return result.candidates
}

afterEach(() => vi.restoreAllMocks())

it('keeps identical-score build identities through shuffled worker completion and inventory reversal', () => {
  for (const reverse of [false, true]) {
    const { form, relics } = fixture({ resultSort: 'COMBO_HEAL' }, true)
    if (reverse) { for (const part of RESULT_PARTS) relics[part].reverse() }
    const order = createResultTieOrder(relics), queue = new OptimizerResultQueue(7, order)
    const expected: { index: number, ids: string[] }[] = []
    function enumerate(slot: number, index: number, ids: string[]) {
      if (slot === 6) {
        expected.push({ index, ids })
        return
      }
      relics[RESULT_PARTS[slot]].forEach((r, i) => enumerate(slot + 1, index * 2 + i, [...ids, r.id]))
    }
    enumerate(0, 0, [])
    expected.sort((a, b) => {
      for (let slot = 0; slot < 6; slot++) if (a.ids[slot] !== b.ids[slot]) return a.ids[slot] < b.ids[slot] ? -1 : 1
      return 0
    })
    for (const [skip, width] of [[38, 26], [0, 19], [19, 19]]) {
      const candidates = run({ ...form, resultMinFilter: queue.size() === 7 ? queue.topPriority() : -Infinity }, relics, skip, width)
      for (let i = 0; i < candidates.length; i += 2) queue.fixedSizePush(candidates[i], candidates[i + 1])
    }
    expect(queue.toResults().sort(order.compareResults).map((r) => r.index)).toEqual(expected.slice(0, 7).map((r) => r.index))
  }
})

const scenarios: { name: string, column: string, patch: Partial<Form> }[] = [
  { name: 'base ATK', column: 'ATK', patch: { resultSort: 'ATK', statDisplay: 'base' } },
  { name: 'combat CD', column: 'xCD', patch: { resultSort: 'CD', statDisplay: 'combat' } },
  { name: 'combat CR', column: 'xCR', patch: { resultSort: 'CR', statDisplay: 'combat' } },
  { name: 'EHP', column: 'EHP', patch: { resultSort: 'EHP' } },
  { name: 'BASIC', column: 'BASIC', patch: { resultSort: 'BASIC' } },
  { name: 'COMBO', column: 'COMBO', patch: { resultSort: 'COMBO' } },
  { name: 'COMBO_HEAL', column: 'COMBO_HEAL', patch: { resultSort: 'COMBO_HEAL' } },
  { name: 'COMBO_SHIELD', column: 'COMBO_SHIELD', patch: { resultSort: 'COMBO_SHIELD' } },
  { name: 'COMBO_BUFF', column: 'COMBO_BUFF', patch: { resultSort: 'COMBO_BUFF' } },
  {
    name: 'memo base HP',
    column: 'mHP',
    patch: {
      characterId: '8008',
      lightCone: '21051',
      characterConditionals: {},
      lightConeConditionals: {},
      comboStateJson: '{}',
      memoDisplay: 'memo',
      statDisplay: 'base',
      resultSort: 'HP',
    },
  },
  {
    name: 'memo combat CD',
    column: 'mxCD',
    patch: {
      characterId: '8008',
      lightCone: '21051',
      characterConditionals: {},
      lightConeConditionals: {},
      comboStateJson: '{}',
      memoDisplay: 'memo',
      statDisplay: 'combat',
      resultSort: 'CD',
    },
  },
  {
    name: 'memo EHP',
    column: 'mxEHP',
    patch: {
      characterId: '8008',
      lightCone: '21051',
      characterConditionals: {},
      lightConeConditionals: {},
      comboStateJson: '{}',
      memoDisplay: 'memo',
      resultSort: 'EHP',
    },
  },
]

function fullRows(form: Form, relics: RelicsByPart) {
  const context = generateContext(form)
  initializeContextConditionals(context)
  const packed = new Float32Array(BufferPacker.createFloatBuffer(1))
  // Explicit six loops are independent of worker's mixed-radix index decoder.
  const oracle: Record<string, number>[] = []
  for (const Head of relics.Head) {
    for (const Hands of relics.Hands) {
      for (const Body of relics.Body) {
        for (const Feet of relics.Feet) {
          for (const PlanarSphere of relics.PlanarSphere) {
            for (const LinkRope of relics.LinkRope) {
              const { x } = simulateBuild({ Head, Hands, Body, Feet, PlanarSphere, LinkRope }, context, null)
              const memo = x.config.entitiesArray.findIndex((e) => e.memosprite)
              BufferPacker.packCharacterContainer(packed, 0, x, x.c, context, memo)
              const row = BufferPacker.extractCharacter(packed, 0, 0) as unknown as Record<string, number>
              const full = formatOptimizerDisplayData(x, context)
              for (const key of ['COMBO_HEAL', 'COMBO_SHIELD', 'COMBO_BUFF'] as const) row[key] = Math.fround(full[key]!)
              oracle.push(row)
            }
          }
        }
      }
    }
  }
  return oracle
}

it.each(scenarios)('$name: batch-local Top K merges to the exhaustive full-row reference', ({ patch, column }) => {
  const { form, relics } = fixture(patch)
  const oracle = fullRows(form, relics)
  const queue = new FixedSizeNumericMinQueue(7)
  // Exercise a short tail and out-of-order worker completion.
  for (const [skip, width] of [[38, 26], [0, 19], [19, 19]]) {
    const candidates = run({ ...form, resultMinFilter: queue.size() === 7 ? queue.topPriority() : -Infinity }, relics, skip, width)
    for (let i = 0; i < candidates.length; i += 2) queue.fixedSizePush(candidates[i], candidates[i + 1])
  }
  const retained = queue.toResults()
  expect(new Set(retained.map((r) => r.index)).size).toBe(7)
  const expected = oracle.map((r) => r[column]).sort((a, b) => b - a).slice(0, 7)
  expect(retained.map((r) => r.value).sort((a, b) => b - a)).toEqual(expected)
  const rows = createCpuResultRows(retained.map((r) => r.index), relics, generateContext(form))
  for (const row of rows) {
    const reference = oracle[row.id]
    for (const [key, value] of Object.entries(reference)) {
      if (key !== 'id') expect(row[key as keyof typeof row], key).toBe(value)
    }
  }
})

it.each(['BASIC', 'COMBO'] as const)('%s respects selective default-action filters', (resultSort) => {
  const { form, relics } = fixture({ resultSort, statDisplay: 'combat' })
  const oracle = fullRows(form, relics)
  const values = oracle.map((row) => row.ULT)
  const minUlt = (Math.min(...values) + Math.max(...values)) / 2
  const valid = oracle.filter((row) => row.ULT >= minUlt)
  expect(valid.length).toBeGreaterThan(0)
  expect(valid.length).toBeLessThan(oracle.length)
  const filtered = { ...form, minUlt }
  const context = generateContext(filtered)
  expect(getCpuActionPlan(filtered, context).defaultActionCount).toBe(
    resultSort === 'COMBO' ? context.defaultActions.length : context.defaultActions.findIndex((action) => action.actionName === 'ULT') + 1,
  )
  const scores = Array.from(run(filtered, relics, 0, 64)).filter((_, i) => i % 2 === 1).sort((a, b) => b - a)
  expect(scores).toEqual(valid.map((row) => row[resultSort]).sort((a, b) => b - a).slice(0, 7))
})

it.each(
  [
    { id: '1409', lightCone: '23042', resultSort: 'COMBO_HEAL', column: 'COMBO_HEAL' },
    { id: '8004', lightCone: '20003', resultSort: 'COMBO_SHIELD', column: 'COMBO_SHIELD' },
    { id: '8008', lightCone: '22006', resultSort: 'COMBO', column: 'COMBO' },
    { id: '1506', lightCone: '21064', resultSort: 'COMBO', column: 'COMBO' },
  ] as const,
)('$id $resultSort skips defaults while matching positive full-simulation scores', ({ id, lightCone, resultSort, column }) => {
  const { form, relics } = fixture({
    ...normalizeForm(generateFullDefaultForm(id, lightCone, 6, 5)),
    resultSort,
    minSpd: 0,
    resultsLimit: 64,
    ...(id === '1409' || id === '8004'
      ? {
        comboType: ComboType.ADVANCED,
        comboTurnAbilities: id === '1409' ? ['NULL', 'DEFAULT_SKILL_HEAL', 'DEFAULT_MEMO_SKILL'] : ['NULL', 'DEFAULT_TALENT_SHIELD'],
        comboStateJson: '{}',
      }
      : {}),
  })
  const absentBounds = Object.fromEntries(Object.values(SortOption).flatMap((option) =>
    option.minFilterKey && option.maxFilterKey ? [[option.minFilterKey, undefined], [option.maxFilterKey, undefined]] : []
  ))
  for (const bounds of [{}, absentBounds]) {
    for (const memoDisplay of ['summoner', 'memo'] as const) {
      const request = { ...form, ...bounds, memoDisplay }
      const context = generateContext(request)
      expect(context.rotationActions.length).toBeGreaterThan(0)
      expect(getCpuActionPlan(request, context).defaultActionCount).toBe(0)
      const oracle = fullRows(request, relics)
      expect(Math.max(...oracle.map((row) => row[column]))).toBeGreaterThan(0)
      for (const [skip, width] of [[0, 64], [17, 29], [0, 64]]) {
        const candidates = run(request, relics, skip, width)
        expect(candidates.length / 2).toBe(width)
        for (let i = 0; i < candidates.length; i += 2) expect(candidates[i + 1]).toBe(oracle[candidates[i]][column])
      }
    }
  }
})

it('prunes the actual loaded COMBO request with omitted filter bounds', () => {
  const { form, relics } = fixture({ resultsLimit: 64 })
  expect(form.minEhp).toBeUndefined()
  expect(form.maxEhp).toBeUndefined()
  expect(getCpuActionPlan(form, generateContext(form)).defaultActionCount).toBe(0)
  const oracle = fullRows(form, relics)
  const candidates = run(form, relics, 0, 64)
  expect(candidates.length / 2).toBe(64)
  for (let i = 0; i < candidates.length; i += 2) expect(candidates[i + 1]).toBe(oracle[candidates[i]].COMBO)
})

it.each(
  [
    { key: 'minUlt', column: 'ULT', lower: true, display: 'base' },
    { key: 'maxUlt', column: 'ULT', lower: false, display: 'base' },
    { key: 'minEhp', column: 'EHP', lower: true, display: 'base' },
    { key: 'maxEhp', column: 'EHP', lower: false, display: 'combat' },
    { key: 'minSpd', column: 'xSPD', lower: true, display: 'combat' },
    { key: 'maxCd', column: 'xCD', lower: false, display: 'combat' },
  ] as const,
)('BASIC objective respects selective $key dependencies after action pruning', ({ key, column, lower, display }) => {
  const { form, relics } = fixture({ resultSort: 'BASIC', statDisplay: display })
  const oracle = fullRows(form, relics)
  const values = oracle.map((row) => row[column])
  const bound = (Math.min(...values) + Math.max(...values)) / 2
  const valid = oracle.filter((row) => lower ? row[column] >= bound : row[column] <= bound)
  expect(valid.length).toBeGreaterThan(0)
  expect(valid.length).toBeLessThan(oracle.length)
  const candidates = run({ ...form, [key]: bound }, relics, 0, 64)
  const scores = Array.from(candidates).filter((_, i) => i % 2 === 1).sort((a, b) => b - a)
  expect(scores).toEqual(valid.map((row) => row.BASIC).sort((a, b) => b - a).slice(0, 7))
})

it.each([1, 7, 100])('keeps zero-valued ties and fewer than K=%i rows without a sentinel', (resultsLimit) => {
  const { form, relics } = fixture({ resultsLimit, resultSort: 'COMBO_HEAL' }, true)
  const candidates = run(form, relics, 0, 64)
  expect(candidates.length / 2).toBe(Math.min(resultsLimit, 64))
  expect(new Set(Array.from(candidates).filter((_, i) => i % 2 === 0)).size).toBe(Math.min(resultsLimit, 64))
})

it.each(['MEMO_SKILL', 'SKILL_HEAL', 'COMBO_HEAL'] as const)('Hyacine %s preserves healing and heal-tally dependencies', (resultSort) => {
  const { form, relics } = fixture({
    ...normalizeForm(generateFullDefaultForm('1409', '23042', 6, 5)),
    resultSort,
    resultsLimit: 7,
    minSpd: 0,
    comboType: ComboType.ADVANCED,
    comboTurnAbilities: ['NULL', 'DEFAULT_SKILL_HEAL', 'DEFAULT_MEMO_SKILL'],
    comboStateJson: '{}',
  })
  const expected = fullRows(form, relics).map((row) => row[resultSort]).sort((a, b) => b - a).slice(0, 7)
  expect(expected[0]).toBeGreaterThan(0)
  const scores = Array.from(run(form, relics, 0, 64)).filter((_, i) => i % 2 === 1).sort((a, b) => b - a)
  expect(scores).toEqual(expected)
})

it('returns an empty compact buffer when all rows fail a rating filter', () => {
  const { form, relics } = fixture({ minUlt: 1e15 })
  expect(run(form, relics, 0, 64)).toHaveLength(0)
})

it('selects negative scores before either queue is full', () => {
  const { form, relics } = fixture({ resultMinFilter: -Infinity })
  const original = ComputedStatsContainer.prototype.getGlobalRegisterValue
  vi.spyOn(ComputedStatsContainer.prototype, 'getGlobalRegisterValue').mockImplementation(function(this: ComputedStatsContainer, key) {
    return key === GlobalRegister.COMBO_DMG ? this.c.id - 64 : original.call(this, key)
  })
  const scores = Array.from(run(form, relics, 0, 64)).filter((_, i) => i % 2 === 1).sort((a, b) => b - a)
  expect(scores).toEqual([-1, -2, -3, -4, -5, -6, -7])
})

it('retains a score just below the floor when its packed float32 value equals the floor', () => {
  const { form, relics } = fixture({ resultMinFilter: 1 })
  const original = ComputedStatsContainer.prototype.getGlobalRegisterValue
  vi.spyOn(ComputedStatsContainer.prototype, 'getGlobalRegisterValue').mockImplementation(function(this: ComputedStatsContainer, key) {
    return key === GlobalRegister.COMBO_DMG ? 1 - 2 ** -26 : original.call(this, key)
  })
  const candidates = run(form, relics, 0, 64)
  expect(Array.from(candidates).filter((_, i) => i % 2 === 1)).toEqual(Array(7).fill(1))
})

it('preserves global indices above 2^32 through selection and reconstruction', () => {
  const { form, relics } = fixture({ resultsLimit: 3 }, true)
  for (const part of Object.keys(relics) as (keyof typeof relics)[]) {
    relics[part] = Array.from({ length: 64 }, (_, i) => ({ ...relics[part][0], id: `${part}-${i}` }))
  }
  const skip = 2 ** 32 + 17
  const candidates = run(form, relics, skip, 7, 64 ** 6)
  const indices = Array.from(candidates).filter((_, i) => i % 2 === 0)
  expect(indices).toHaveLength(3)
  expect(indices.every((i) => i >= skip && i < skip + 7)).toBe(true)
  expect(createCpuResultRows(indices, relics, generateContext(form)).map((r) => r.id)).toEqual(indices)
})

it('keeps only the requested four-piece and ornament pair after repeated compact dispatch', () => {
  const { form, relics } = fixture({ resultSort: 'COMBO_HEAL', resultsLimit: 64 }, true)
  const [allowedRelic, otherRelic] = Object.values(SetsRelics)
  const [allowedOrnament, otherOrnament] = Object.values(SetsOrnaments)
  for (const part of RESULT_PARTS) {
    const ornament = part === 'PlanarSphere' || part === 'LinkRope'
    relics[part][0].set = ornament ? allowedOrnament : allowedRelic
    relics[part][1].set = ornament ? otherOrnament : otherRelic
  }
  form.relicSets = [[RelicSetFilterOptions.relic4Piece, allowedRelic]]
  form.ornamentSets = [allowedOrnament]
  const setSolutions = {
    relicSetSolutions: bitpackBooleanArray(generateRelicSetSolutions(form)),
    ornamentSetSolutions: bitpackBooleanArray(generateOrnamentSetSolutions(form)),
  }
  for (let repeat = 0; repeat < 3; repeat++) expect(Array.from(run(form, relics, 0, 64, 64, setSolutions))).toEqual([0, 0])
  expect(run(form, relics, 1, 63, 64, setSolutions)).toHaveLength(0)
})

it('preserves unrounded and ordered stat contributions with absent or empty slot stats', () => {
  const { form, relics } = fixture({ resultSort: 'ATK', statDisplay: 'base', resultsLimit: 64 })
  for (const part of RESULT_PARTS) for (const relic of relics[part]) relic.condensedStats = []
  delete relics.Hands[0].condensedStats
  // Rounding each input value to float32 before addition would change the first sum from 2 to 0.
  relics.Head[0].condensedStats = [[BasicKey.ATK, 1], [BasicKey.ATK, 16777217], [BasicKey.ATK, -16777216]]
  relics.Head[1].condensedStats = [[BasicKey.ATK, 1]]
  const oracle = fullRows(form, relics)
  expect(oracle[0].ATK - oracle[32].ATK).toBe(1)
  const candidates = run(form, relics, 0, 64)
  for (let i = 0; i < candidates.length; i += 2) expect(candidates[i + 1]).toBe(oracle[candidates[i]].ATK)
})

it('matches independent six-loop scores across unequal slot carries and a singleton slot', () => {
  const { form, relics } = fixture({ resultSort: 'ATK', statDisplay: 'base', resultsLimit: 200 })
  const sizes = [2, 3, 1, 2, 3, 4]
  for (let slot = 0; slot < RESULT_PARTS.length; slot++) {
    const part = RESULT_PARTS[slot]
    const original = relics[part][0]
    relics[part] = Array.from({ length: sizes[slot] }, (_, index) => ({
      ...original,
      id: `${part}-${index}`,
      condensedStats: [[BasicKey.ATK, (slot + 1) * 17 + index * 3.25]],
    }))
  }
  const oracle = fullRows(form, relics)
  const total = sizes.reduce((a, b) => a * b, 1)
  expect(oracle).toHaveLength(total)
  for (const [skip, width] of [[0, total], [3, 23], [21, 60], [total - 5, 20], [total, 5], [17, 0]]) {
    const candidates = run(form, relics, skip, width, total)
    const actual = Array.from({ length: candidates.length / 2 }, (_, i) => [candidates[i * 2], candidates[i * 2 + 1]])
      .sort((a, b) => a[0] - b[0])
    const expected = oracle.slice(skip, Math.min(total, skip + width)).map((row, i) => [skip + i, row.ATK])
    expect(actual).toEqual(expected)
  }
})

it('stops an oversized tail batch at the exact domain end above 2^48', () => {
  const { form, relics } = fixture({ resultSort: 'ATK', statDisplay: 'base', resultsLimit: 16 }, true)
  const size = 257
  for (const part of RESULT_PARTS) {
    relics[part] = Array.from({ length: size }, (_, i) => ({
      ...relics[part][0],
      id: `${part}-${i}`,
      condensedStats: [[BasicKey.ATK, i * (RESULT_PARTS.indexOf(part) + 1) * 3.25]],
    }))
  }
  const total = size ** 6
  expect(total).toBeGreaterThan(2 ** 48)
  expect(Number.isSafeInteger(total)).toBe(true)
  const candidates = run(form, relics, total - 7, 30, total)
  const indices = Array.from(candidates).filter((_, i) => i % 2 === 0).sort((a, b) => a - b)
  expect(indices).toEqual(Array.from({ length: 7 }, (_, i) => total - 7 + i))
  const tailRelics = { ...relics }
  for (const part of RESULT_PARTS) tailRelics[part] = part === 'LinkRope' ? relics[part].slice(-7) : [relics[part].at(-1)!]
  const oracle = fullRows(form, tailRelics)
  for (let i = 0; i < candidates.length; i += 2) expect(candidates[i + 1]).toBe(oracle[candidates[i] - (total - 7)].ATK)
})
