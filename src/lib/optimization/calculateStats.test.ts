import { Stats, type StatsValues } from 'lib/constants/constants'
import { BasicKey, BasicStatsArrayCore, BasicStatToKey, type BasicStatsArray } from 'lib/optimization/basicStatsArray'
import { calculateBaseStats, calculateComputedStats, calculateElementalStats } from 'lib/optimization/calculateStats'
import { StatKey } from 'lib/optimization/engine/config/keys'
import { TargetTag } from 'lib/optimization/engine/config/tag'
import { ComputedStatsContainer, type ComputedStatsContainerConfig } from 'lib/optimization/engine/container/computedStatsContainer'
import type { OptimizerAction, OptimizerContext } from 'types/optimizer'
import { expect, it } from 'vitest'

const flat = [Stats.SPD, Stats.HP, Stats.ATK, Stats.DEF] as const
const percent = [Stats.CR, Stats.CD, Stats.EHR, Stats.RES, Stats.BE, Stats.ERR, Stats.OHB] as const
const elements = [Stats.Physical_DMG, Stats.Fire_DMG, Stats.Ice_DMG, Stats.Lightning_DMG, Stats.Wind_DMG, Stats.Quantum_DMG, Stats.Imaginary_DMG] as const
const special = [0, -0, 1, -1, 1e-30, 1e30, Infinity, -Infinity, NaN]

it('uses the current action stride for each memosprite and leaves other entities and padding intact', () => {
  const x = new ComputedStatsContainer()
  const c = new BasicStatsArrayCore(false) as BasicStatsArray
  for (let i = 0; i < c.a.length; i++) c.a[i] = i * 0.125 - 3
  const stats = [StatKey.ATK, StatKey.DEF, StatKey.HP, StatKey.SPD]
  const percentages = [StatKey.ATK_P, StatKey.DEF_P, StatKey.HP_P, StatKey.SPD_P]
  const secondary = ['CD', 'CR', 'BE', 'EHR', 'RES', 'ERR', 'OHB',
    'PHYSICAL_DMG_BOOST', 'FIRE_DMG_BOOST', 'ICE_DMG_BOOST', 'LIGHTNING_DMG_BOOST',
    'WIND_DMG_BOOST', 'QUANTUM_DMG_BOOST', 'IMAGINARY_DMG_BOOST', 'ELATION'] as const
  const entities = [{ memosprite: false }, { memosprite: true }, { memosprite: false }, { memosprite: true }].map((entity, i) => ({
    ...entity, memoBaseAtkScaling: 0.5, memoBaseDefScaling: 0.5, memoBaseHpScaling: 0.5, memoBaseSpdScaling: 0.5,
    memoBaseAtkFlat: i, memoBaseDefFlat: i, memoBaseHpFlat: i, memoBaseSpdFlat: i,
    baseAtk: 100, baseDef: 100, baseHp: 100, baseSpd: 100,
  }))
  const context = { characterController: {}, lightConeController: {}, baseSPD: 100, baseATK: 100, baseHP: 100, baseDEF: 100 } as OptimizerContext
  for (const stride of [128, 256, 160, 128]) {
    x.config = { entityStride: stride, entitiesLength: entities.length, entitiesArray: entities,
      entityBaseOffsets: { [TargetTag.SelfAndPet]: [] },
    } as unknown as ComputedStatsContainerConfig
    x.c = c
    x.a = Float64Array.from({ length: stride * 4 + 32 }, (_, i) => Math.sin(i) * 0.25)
    const expected = x.a.slice()
    for (const index of [1, 3]) {
      for (const key of stats) expected[x.getActionIndex(index, key)] += 0.5 * c.a[key] + index
      for (const key of secondary) expected[x.getActionIndex(index, StatKey[key])] += c.a[BasicKey[key]]
      stats.forEach((key, i) => { expected[x.getActionIndex(index, key)] += expected[x.getActionIndex(index, percentages[i])] * 100 })
    }
    calculateComputedStats(x, { setConditionals: {} } as OptimizerAction, context)
    expect(Array.from(x.a)).toEqual(Array.from(expected))
  }
})

function fixture(seed: number, edge: boolean) {
  const value = (n: number) => edge ? special[(n + seed) % special.length] : Math.sin(n * 47 + seed) * 1234.56789
  const record = (offset: number) => Object.fromEntries(Object.values(Stats).map((stat, i) => [stat, value(i + offset)]))
  const base = record(1), lc = record(3), trace = record(5)
  const c = new BasicStatsArrayCore(false) as BasicStatsArray
  for (let i = 0; i < c.a.length; i++) c.a[i] = value(i + 7)
  const context = { characterStatsBreakdown: { base, lightCone: lc, traces: trace },
    baseSPD: value(11), baseHP: value(12), baseATK: value(13), baseDEF: value(14),
  } as unknown as OptimizerContext
  return { c, context, base, lc, trace }
}

// Generic pre-optimization formulas serve as the oracle for static key expansion.
function percentOracle(stat: StatsValues, base: Record<string, number>, lc: Record<string, number>, trace: Record<string, number>, a: Float32Array) {
  return base[stat] + lc[stat] + a[BasicStatToKey[stat]] + trace[stat] + 0
}

it.each([false, true])('preserves every basic-stat value with edge values=%s and fresh context values', (edge) => {
  for (let seed = 0; seed < 64; seed++) {
    const { c, context, base, lc, trace } = fixture(seed, edge)
    const expected = c.a.slice()
    const bases = [context.baseSPD, context.baseHP, context.baseATK, context.baseDEF]
    const percentages = [Stats.SPD_P, Stats.HP_P, Stats.ATK_P, Stats.DEF_P]
    flat.forEach((stat, i) => {
      const statP = percentages[i]
      expected[BasicStatToKey[stat]] = bases[i] * (1 + 0 + expected[BasicStatToKey[statP]] + trace[statP] + lc[statP])
        + expected[BasicStatToKey[stat]] + trace[stat]
    })
    for (const stat of percent) expected[BasicStatToKey[stat]] = percentOracle(stat, base, lc, trace, expected)
    calculateBaseStats(c, context)
    // Object.is via toEqual preserves signed-zero and NaN semantics.
    expect(Array.from(c.a)).toEqual(Array.from(expected))
  }
})

it.each(elements)('preserves %s element and Elation values without touching unrelated stats', (element) => {
  for (let seed = 0; seed < 18; seed++) {
    const { c, context, base, lc, trace } = fixture(seed, seed >= 9)
    context.elementalDamageType = element
    const expected = c.a.slice()
    expected[BasicKey.ELEMENTAL_DMG] = 0
    expected[BasicStatToKey[element]] = percentOracle(element, base, lc, trace, expected)
    expected[BasicKey.ELATION] = percentOracle(Stats.Elation, base, lc, trace, expected)
    calculateElementalStats(c, context)
    expect(Array.from(c.a)).toEqual(Array.from(expected))
  }
})
