import { AToHKey, HKey, StatKey } from 'lib/optimization/engine/config/keys'
import { ElementTag } from 'lib/optimization/engine/config/tag'
import { ComputedStatsContainer, type ComputedStatsContainerConfig } from 'lib/optimization/engine/container/computedStatsContainer'
import { AdditionalDamageFunction, CritDamageFunction, DamageFunctionType, DotDamageFunction } from 'lib/optimization/engine/damage/damageCalculator'
import type { AdditionalHit, CritHit, DotHit, Hit } from 'types/hitConditionalTypes'
import type { OptimizerAction, OptimizerContext } from 'types/optimizer'
import { expect, it } from 'vitest'

it('keeps all specialized common-multiplier stats mapped to hit slots', () => {
  for (const key of ['DEF_PEN', 'RES_PEN', 'VULNERABILITY', 'FINAL_DMG_BOOST'] as const) {
    expect(AToHKey[StatKey[key]]).toBe(HKey[key])
    expect(HKey[key]).toBeTypeOf('number')
  }
})

it('keeps specialized initial-damage and crit stat layouts explicit', () => {
  for (const key of ['ATK', 'HP', 'DEF', 'BE', 'CR', 'CD'] as const) {
    expect(AToHKey[StatKey[key]]).toBe(HKey[key])
    expect(HKey[key]).toBeTypeOf('number')
  }
  for (const key of ['ELATION', 'CR_BOOST', 'CD_BOOST'] as const) {
    expect(AToHKey[StatKey[key]]).toBeUndefined()
  }
})

it('preserves initial scaling, crit clamps and additional overrides with generic-getter formulas', () => {
  const x = new ComputedStatsContainer()
  const context = { enemyLevel: 95, enemyDamageResistance: 0.35, enemyEffectResistance: 0.4 } as OptimizerContext
  const scalings: Partial<CritHit>[] = [
    {},
    { atkScaling: 0, hpScaling: 0.3, defScaling: -0.2 },
    { atkScaling: 0.7, beScaling: 0.2 },
    { atkScaling: 0.7, beScaling: 0.2, beCap: 0 },
    { atkScaling: 0.7, beScaling: 0.2, beCap: 0.6 },
    { elationAtkScaling: 0.4 },
    { atkScaling: 0.7, beScaling: 0.2, beCap: 0.6, elationAtkScaling: 0.4 },
  ]
  for (const padding of [0, 31, 7, 0]) {
    for (const sourceEntityIndex of [undefined, 0, 1, 3]) {
      for (const scalingEntityIndex of [undefined, 0, 2]) {
        for (const scaling of scalings) {
          const hit = { sourceEntityIndex, scalingEntityIndex, damageElement: ElementTag.None,
            hpScaling: 0.1, defScaling: 0.4, trueDmgModifier: 0.05, ...scaling,
          } as CritHit
          const hits = [hit, { ...hit, sourceEntityIndex: 2 }]
          const actionStatsLength = Object.keys(StatKey).length
          const hitStatsLength = Object.keys(HKey).length
          const entityStride = actionStatsLength + hits.length * hitStatsLength + padding
          x.config = { hits, actionStatsLength, hitStatsLength, entityStride, enemyWeaknessBroken: padding === 0 } as ComputedStatsContainerConfig
          x.a = Float64Array.from({ length: entityStride * 4 }, (_, i) => Math.sin(i * 7 + padding) * 2)
          const action = { hits } as OptimizerAction
          for (const hitIndex of [0, 1, 0]) {
            const current = hits[hitIndex]
            const entity = current.scalingEntityIndex ?? current.sourceEntityIndex ?? 0
            const atk = x.getValue(StatKey.ATK, hitIndex, entity)
            const hp = x.getValue(StatKey.HP, hitIndex, entity)
            const def = x.getValue(StatKey.DEF, hitIndex, entity)
            let atkScaling = current.atkScaling ?? 0
            if (current.beScaling != null) {
              const be = x.getValue(StatKey.BE, hitIndex, entity)
              atkScaling += current.beScaling * (current.beCap != null ? Math.min(current.beCap, be) : be)
            }
            if (current.elationAtkScaling != null) atkScaling += current.elationAtkScaling * x.getValue(StatKey.ELATION, hitIndex, entity)
            const initial = atkScaling * atk + (current.hpScaling ?? 0) * hp + (current.defScaling ?? 0) * def
            const defMulti = 100 / ((context.enemyLevel + 20) * Math.max(0, 1 - x.getValue(StatKey.DEF_PEN, hitIndex)) + 100)
            const res = 1 - Math.min(0.90, Math.max(-1.00, context.enemyDamageResistance - x.getValue(StatKey.RES_PEN, hitIndex)))
            const vuln = 1 + Math.min(2.50, Math.max(0, x.getValue(StatKey.VULNERABILITY, hitIndex)))
            const final = 1 + x.getValue(StatKey.FINAL_DMG_BOOST, hitIndex)
            const boost = 1 + x.getValue(StatKey.BOOST, hitIndex) + 0
            const base = (x.config.enemyWeaknessBroken ? 1 : 0.9) * defMulti * res * vuln * final * boost * initial
            const cr = Math.min(1, x.getValue(StatKey.CR, hitIndex) + x.getValue(StatKey.CR_BOOST, hitIndex))
            const cd = x.getValue(StatKey.CD, hitIndex) + x.getValue(StatKey.CD_BOOST, hitIndex)
            const trueDmg = 1 + x.getValue(StatKey.TRUE_DMG_MODIFIER, hitIndex) + (current.trueDmgModifier ?? 0)
            expect(CritDamageFunction.apply(x, action, hitIndex, context)).toBe(base * (cr * (1 + cd) + (1 - cr)) * trueDmg)
            for (const crOverride of [undefined, 0, 0.3, 1.4]) {
              for (const cdOverride of [undefined, 0, -0.3, 2.1]) {
                const additional: AdditionalHit = { ...current, damageFunctionType: DamageFunctionType.Additional, crOverride, cdOverride, tickCoefficient: 0.7 }
                const additionalHits: Hit[] = [...hits]
                additionalHits[hitIndex] = additional
                const additionalCr = crOverride ?? cr
                const additionalCd = cdOverride ?? cd
                const expected = base * (additionalCr * (1 + additionalCd) + (1 - additionalCr)) * trueDmg * 0.7
                expect(AdditionalDamageFunction.apply(x, { hits: additionalHits } as OptimizerAction, hitIndex, context)).toBe(expected)
              }
            }
            const dot: DotHit = { ...current, damageFunctionType: DamageFunctionType.Dot, dotBaseChance: 0.8, tickCoefficient: 0.6 }
            const dotHits: Hit[] = [...hits]
            dotHits[hitIndex] = dot
            const ehr = Math.min(1, 0.8 * (1 + x.getValue(StatKey.EHR, hitIndex))
              * (1 - context.enemyEffectResistance + x.getValue(StatKey.EFFECT_RES_PEN, hitIndex)))
            expect(DotDamageFunction.apply(x, { hits: dotHits } as OptimizerAction, hitIndex, context)).toBe(base * ehr * trueDmg * 0.6)
          }
        }
      }
    }
  }
})

it('matches generic getters across entities, hits and changing action layouts', () => {
  const x = new ComputedStatsContainer()
  const context = { enemyLevel: 95, enemyDamageResistance: 0.35 } as OptimizerContext
  for (const padding of [0, 31, 7, 0]) {
    for (const sourceEntityIndex of [undefined, 0, 1, 3]) {
      const hit = { sourceEntityIndex, scalingEntityIndex: 2, damageElement: ElementTag.None,
        atkScaling: 0.7, hpScaling: 0.1, defScaling: 0.4, trueDmgModifier: 0.05,
      } as CritHit
      const hits = [hit, hit]
      const actionStatsLength = Object.keys(StatKey).length
      const hitStatsLength = Object.keys(HKey).length
      const entityStride = actionStatsLength + hits.length * hitStatsLength + padding
      x.config = { hits, actionStatsLength, hitStatsLength, entityStride, enemyWeaknessBroken: padding === 0 } as ComputedStatsContainerConfig
      x.a = Float64Array.from({ length: entityStride * 4 }, (_, i) => Math.sin(i * 7 + padding) * 0.7)
      const action = { hits } as OptimizerAction
      for (const hitIndex of [0, 1, 0]) {
        const def = 100 / ((context.enemyLevel + 20) * Math.max(0, 1 - x.getValue(StatKey.DEF_PEN, hitIndex)) + 100)
        const res = 1 - Math.min(0.90, Math.max(-1.00, context.enemyDamageResistance - x.getValue(StatKey.RES_PEN, hitIndex)))
        const vuln = 1 + Math.min(2.50, Math.max(0, x.getValue(StatKey.VULNERABILITY, hitIndex)))
        const final = 1 + x.getValue(StatKey.FINAL_DMG_BOOST, hitIndex)
        const boost = 1 + x.getValue(StatKey.BOOST, hitIndex) + 0
        const initial = 0.7 * x.getValue(StatKey.ATK, hitIndex, 2) + 0.1 * x.getValue(StatKey.HP, hitIndex, 2)
          + 0.4 * x.getValue(StatKey.DEF, hitIndex, 2)
        const cr = Math.min(1, x.getValue(StatKey.CR, hitIndex) + x.getValue(StatKey.CR_BOOST, hitIndex))
        const cd = x.getValue(StatKey.CD, hitIndex) + x.getValue(StatKey.CD_BOOST, hitIndex)
        const crit = cr * (1 + cd) + (1 - cr)
        const trueDmg = 1 + x.getValue(StatKey.TRUE_DMG_MODIFIER, hitIndex) + 0.05
        const expected = (x.config.enemyWeaknessBroken ? 1 : 0.9) * def * res * vuln * final * boost * initial * crit * trueDmg
        expect(CritDamageFunction.apply(x, action, hitIndex, context)).toBe(expected)
      }
    }
  }
})
