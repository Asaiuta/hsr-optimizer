import { dynamicStatConversionContainer } from 'lib/conditionals/evaluation/statConversion'
import { aKeyToConvertibleStat, type ConvertibleStatsType, statConversionConfig } from 'lib/conditionals/evaluation/statConversionConfig'
import { ConditionalActivation, Stats } from 'lib/constants/constants'
import { type DynamicConditional, evaluateConditional } from 'lib/gpu/conditionals/dynamicConditionals'
import { Source } from 'lib/optimization/buffSource'
import { emptyRegistry } from 'lib/optimization/calculateConditionals'
import { StatKey } from 'lib/optimization/engine/config/keys'
import { computeTargetMask, TargetTag } from 'lib/optimization/engine/config/tag'
import { ComputedStatsContainer, ComputedStatsContainerConfig, type OptimizerEntity, rebuildEntityRegistry } from 'lib/optimization/engine/container/computedStatsContainer'
import { NamedArray } from 'lib/optimization/engine/util/namedArray'
import type { Hit } from 'types/hitConditionalTypes'
import type { OptimizerAction, OptimizerContext } from 'types/optimizer'
import { expect, it } from 'vitest'

function fixture(hitsLength = 0, serialized = false, deprioritizeBuffs = false) {
  const entities: OptimizerEntity[] = [
    { name: 'self', primary: true, memoBuffPriority: true },
    { name: 'pet', pet: true },
    { name: 'memo', memosprite: true },
    { name: 'summon', summon: true },
  ].map((e) => {
    const entity = { primary: false, pet: false, memosprite: false, summon: false, baseAtk: 0, baseDef: 0, baseHp: 0, baseSpd: 0, ...e }
    return { ...entity, targetMask: computeTargetMask(entity) }
  })
  const action = { hits: Array.from({ length: hitsLength }, () => ({} as Hit)), actionType: 'SKILL',
    conditionalRegistry: emptyRegistry(), conditionalState: {},
  } as OptimizerAction
  const context = { allActions: [action], outputRegistersLength: 0, deprioritizeBuffs } as OptimizerContext
  let config = new ComputedStatsContainerConfig(action, context, new NamedArray(entities, (e) => e.name))
  if (serialized) {
    config = JSON.parse(JSON.stringify(config)) as ComputedStatsContainerConfig
    rebuildEntityRegistry(config)
  }
  const x = new ComputedStatsContainer()
  x.setConfig(config)
  x.a = new Float64Array(config.arrayLength)
  return { x, action, context }
}

function conditional(id: string, effect: DynamicConditional['effect'] = () => {}): DynamicConditional {
  return { id, type: 0, activation: ConditionalActivation.CONTINUOUS, dependsOn: [], chainsTo: [], condition: () => true, effect, gpu: () => '' }
}

it('unconvertible destination keys are not dynamic dependency keys', () => {
  for (const config of Object.values(statConversionConfig)) {
    expect(aKeyToConvertibleStat[config.key]).toBe(config.stat)
    expect(aKeyToConvertibleStat[config.unconvertibleKey]).toBeUndefined()
  }
  expect(Object.keys(emptyRegistry()).sort()).toEqual(Object.keys(statConversionConfig).sort())
})

for (const serialized of [false, true]) {
  it(`all conversion pairs preserve both destination writes and source selection (serialized=${serialized})`, () => {
    const { x, action, context } = fixture(3, serialized)
    const stats = Object.keys(statConversionConfig) as ConvertibleStatsType[]
    const c = conditional('conversion')
    for (const source of stats) {
      for (const dest of stats) {
        const sourceConfig = statConversionConfig[source]
        const destConfig = statConversionConfig[dest]
        x.a.fill(0)
        x.a[sourceConfig.key] = 48
        x.a[sourceConfig.unconvertibleKey] = 16
        // Another entity must never supply the conversion input.
        x.a[x.config.entityStride + sourceConfig.key] = 4096
        action.conditionalState = {}
        const expected = x.a.slice()
        for (const entity of [0, 1, 2]) {
          expected[entity * x.config.entityStride + destConfig.unconvertibleKey] += 8
          expected[entity * x.config.entityStride + destConfig.key] += 8
        }
        dynamicStatConversionContainer(source, dest, c, x, action, context, Source.NONE, (value) => value / 4, TargetTag.SelfAndMemosprite)
        expect(x.a).toEqual(expected)
        expect(action.conditionalState.conversion).toBe(8)
        dynamicStatConversionContainer(source, dest, c, x, action, context, Source.NONE, (value) => value / 4, TargetTag.SelfAndMemosprite)
        expect(x.a).toEqual(expected)
      }
    }
  })
}

for (const trace of [false, true]) {
  for (const convertibleOutput of [false, true]) {
    it(`targeting, traces and deferral stay consistent (trace=${trace}, convertible=${convertibleOutput})`, () => {
      const source = Source.character('1503').SOURCE_TRACE
      const targets = new Map<TargetTag, number[]>([
        [TargetTag.None, [0]], [TargetTag.Self, [0]], [TargetTag.Pet, [1]], [TargetTag.Memosprite, [2]],
        [TargetTag.Summon, [3]], [TargetTag.SelfAndPet, [0, 1]], [TargetTag.SelfAndMemosprite, [0, 1, 2]],
        [TargetTag.SelfAndSummon, [0, 3]], [TargetTag.SingleTarget, [2]], [TargetTag.FullTeam, [0, 1, 2, 3]],
      ])
      for (const deprioritize of [false, true]) {
        for (const [tag, indices] of targets) {
          const { x, action, context } = fixture(2, false, deprioritize)
          if (trace) x.enableTracing()
          x.a[StatKey.DEF] = 32
          const expected = x.a.slice()
          const selected = deprioritize && tag === TargetTag.SingleTarget ? [] : indices
          for (const entity of selected) {
            expected[entity * x.config.entityStride + StatKey.OHB] += 8
            if (!convertibleOutput) expected[entity * x.config.entityStride + StatKey.UNCONVERTIBLE_OHB_BUFF] += 8
          }
          let dependencyCalls = 0
          action.conditionalRegistry[Stats.OHB] = [conditional('dependency', () => { dependencyCalls++ })]
          dynamicStatConversionContainer(Stats.DEF, Stats.OHB, conditional('c'), x, action, context, source, (v) => v / 4, tag, convertibleOutput)
          expect(x.a).toEqual(expected)
          expect(action.conditionalState.c).toBe(8)
          // Existing behavior: deferred target writes still dispatch dependencies.
          expect(dependencyCalls).toBe(1)
          const keys = convertibleOutput ? [StatKey.OHB] : [StatKey.UNCONVERTIBLE_OHB_BUFF, StatKey.OHB]
          expect(x.buffs.map((b) => b.key)).toEqual(trace && selected.some((i) => i !== 2) ? keys : [])
          expect(x.buffsMemo.map((b) => b.key)).toEqual(trace && selected.includes(2) ? keys : [])
          for (const buff of [...x.buffs, ...x.buffsMemo]) {
            expect(buff.source).toEqual(source)
            expect(buff.value).toBe(8)
          }
        }
      }
    })
  }
}

it('state advances before chained conversions and unconvertible output blocks further conversion', () => {
  const { x, action, context } = fixture()
  const seen: number[][] = []
  const first = conditional('defToElation', (x, a, context) => {
    dynamicStatConversionContainer(Stats.DEF, Stats.Elation, first, x, a, context, Source.NONE, (v) => v / 100, TargetTag.Self, true)
  })
  const second = conditional('elationToHealing', (x, a, context) => {
    seen.push([a.conditionalState.defToElation, x.getSelfValue(StatKey.ELATION)])
    dynamicStatConversionContainer(Stats.Elation, Stats.OHB, second, x, a, context, Source.NONE, (v) => v / 2, TargetTag.Self)
  })
  const last = conditional('observe', (x, a) => {
    seen.push([a.conditionalState.elationToHealing, x.getSelfValue(StatKey.OHB), x.getSelfValue(StatKey.UNCONVERTIBLE_OHB_BUFF)])
  })
  action.conditionalRegistry[Stats.Elation] = [second]
  action.conditionalRegistry[Stats.OHB] = [last]
  x.a[StatKey.DEF] = 50
  evaluateConditional(first, x, action, context)
  expect(seen).toEqual([[0.5, 0.5], [0.25, 0.25, 0.25]])
  seen.length = 0
  x.a[StatKey.DEF] = 25
  evaluateConditional(first, x, action, context)
  expect(seen).toEqual([[0.25, 0.25], [0.125, 0.125, 0.125]])
})

it('preserves small-delta state updates, threshold retraction and nonpositive-input early return', () => {
  const { x, action, context } = fixture()
  const c = conditional('threshold')
  x.a[StatKey.DEF] = 100
  let result = 0.5
  const apply = () => dynamicStatConversionContainer(Stats.DEF, Stats.OHB, c, x, action, context, Source.NONE, () => result, TargetTag.Self)
  apply()
  expect(x.a[StatKey.OHB]).toBe(0.5)
  result = 0.50005
  apply()
  expect(action.conditionalState.threshold).toBe(result)
  expect(x.a[StatKey.OHB]).toBe(0.5)
  result = 0.7
  apply()
  const accumulated = 0.5 + (0.7 - 0.50005)
  expect(x.a[StatKey.OHB]).toBe(accumulated)
  result = -1
  apply()
  expect(action.conditionalState.threshold).toBe(0)
  expect(x.a[StatKey.OHB]).toBe(accumulated - 0.7)
  x.a[StatKey.DEF] = 0
  result = 5
  apply()
  expect(action.conditionalState.threshold).toBe(0)
  expect(x.a[StatKey.OHB]).toBe(accumulated - 0.7)
})
