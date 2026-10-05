import {
  ACTION_STATS_LENGTH,
  type AKeyValue,
} from 'lib/optimization/engine/config/keys'
import {
  computeTargetMask,
  TargetTag,
} from 'lib/optimization/engine/config/tag'
import {
  ComputedStatsContainer,
  ComputedStatsContainerConfig,
  type OptimizerEntity,
  rebuildEntityRegistry,
} from 'lib/optimization/engine/container/computedStatsContainer'
import { NamedArray } from 'lib/optimization/engine/util/namedArray'
import type { Hit } from 'types/hitConditionalTypes'
import type {
  OptimizerAction,
  OptimizerContext,
} from 'types/optimizer'
import {
  expect,
  it,
} from 'vitest'

function entity(name: string, flags: Partial<OptimizerEntity>): OptimizerEntity {
  const result = { name, primary: false, pet: false, memosprite: false, summon: false, targetMask: 0, baseAtk: 0, baseDef: 0, baseHp: 0, baseSpd: 0, ...flags }
  result.targetMask = computeTargetMask(result)
  return result
}

for (const hitsLength of [0, 1, 7]) {
  for (const serialized of [false, true]) {
    it(`action writes preserve targeting and all stats (${hitsLength} hits, serialized=${serialized})`, () => {
      for (let layout = 0; layout < 8; layout++) {
        for (const memoBuffPriority of [false, true]) {
          const entities = [entity('self', { primary: true, memoBuffPriority })]
          if (layout & 1) entities.push(entity('pet', { pet: true }))
          if (layout & 2) entities.push(entity('memo', { memosprite: true }))
          if (layout & 4) entities.push(entity('summon', { summon: true }))
          const hasMemo = entities.some((entry) => entry.name === 'memo')
          // Independent named-entity oracle, including the existing single-entity fast path.
          const targets = new Map<TargetTag, string[]>([
            [TargetTag.None, []],
            [TargetTag.Self, ['self']],
            [TargetTag.Pet, ['pet']],
            [TargetTag.Memosprite, ['memo']],
            [TargetTag.Summon, ['summon']],
            [TargetTag.FullTeam, ['self', 'pet', 'memo', 'summon']],
            [TargetTag.SingleTarget, memoBuffPriority && hasMemo ? ['memo'] : ['self', 'pet']],
            [TargetTag.SelfAndPet, ['self', 'pet']],
            [TargetTag.SelfAndMemosprite, ['self', 'pet', 'memo']],
            [TargetTag.SelfAndSummon, ['self', 'summon']],
          ])
          let config = new ComputedStatsContainerConfig(
            { hits: Array.from({ length: hitsLength }, () => ({} as Hit)), actionType: 'SKILL' } as OptimizerAction,
            { allActions: [null, null], outputRegistersLength: 3 } as unknown as OptimizerContext,
            new NamedArray(entities, (entry) => entry.name),
          )
          if (serialized) {
            config = JSON.parse(JSON.stringify(config)) as ComputedStatsContainerConfig
            rebuildEntityRegistry(config)
          }
          const container = new ComputedStatsContainer()
          container.setConfig(config)
          container.a = new Float64Array(config.arrayLength)
          const values = [0.1, -0, Infinity, -Infinity, NaN, 1e-300, 1e300]
          for (const [tag, names] of targets) {
            container.a.fill(-7)
            const expected = new Float64Array(config.arrayLength).fill(-7)
            for (const operation of ['actionSet', 'actionBuff', 'actionBuff'] as const) {
              for (let key = 0; key < ACTION_STATS_LENGTH; key++) {
                const value = values[key % values.length]
                container[operation](key as AKeyValue, value, tag)
                for (let index = 0; index < entities.length; index++) {
                  if (entities.length !== 1 && !names.includes(entities[index].name)) continue
                  const offset = index * config.entityStride + key
                  if (operation === 'actionSet') expected[offset] = value
                  else expected[offset] += value
                }
              }
              expect(container.a, `layout=${layout}, priority=${memoBuffPriority}, tag=${tag}, ${operation}`).toEqual(expected)
            }
          }
        }
      }
    })
  }
}
