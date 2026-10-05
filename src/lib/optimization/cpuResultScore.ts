import {
  BasicKey,
  type BasicKeyType,
} from 'lib/optimization/basicStatsArray'
import {
  StatKey,
  type StatKeyValue,
} from 'lib/optimization/engine/config/keys'
import type {
  ComputedStatsContainer,
  OptimizerEntity,
} from 'lib/optimization/engine/container/computedStatsContainer'
import { SortOption } from 'lib/optimization/sortOptions'
import type { Form } from 'types/form'
import type { OptimizerContext } from 'types/optimizer'

export type BasicStatTransform = readonly [scale: number, flat: number]

export function getMemoBasicStatTransform(statKey: number, memoEntity?: OptimizerEntity): BasicStatTransform | undefined {
  if (!memoEntity) return undefined
  switch (statKey) {
    case StatKey.HP:
      return [memoEntity.memoBaseHpScaling ?? 0, memoEntity.memoBaseHpFlat ?? 0]
    case StatKey.ATK:
      return [memoEntity.memoBaseAtkScaling ?? 0, memoEntity.memoBaseAtkFlat ?? 0]
    case StatKey.DEF:
      return [memoEntity.memoBaseDefScaling ?? 0, memoEntity.memoBaseDefFlat ?? 0]
    case StatKey.SPD:
      return [memoEntity.memoBaseSpdScaling ?? 0, memoEntity.memoBaseSpdFlat ?? 0]
    default:
      return undefined
  }
}

/** Read the same float32 score previously sent in the full packed CPU row. */
export function createCpuResultScore(request: Form, context: OptimizerContext, entityIndex: number, memoEntity?: OptimizerEntity) {
  const option = SortOption[request.resultSort!]
  let basic: ((c: Float32Array) => number) | undefined
  let read: (x: ComputedStatsContainer) => number
  if (!option.isComputedRating) {
    const key = BasicKey[option.key as BasicKeyType]
    if (request.statDisplay !== 'combat') {
      const transform = getMemoBasicStatTransform(key, memoEntity)
      basic = transform
        ? (c) => Math.fround(transform[0] * c[key] + transform[1])
        : (c) => c[key]
      const readBasic = basic
      read = (x) => readBasic(x.c.a)
    } else {
      const boost = option.key === 'CR' ? StatKey.CR_BOOST : option.key === 'CD' ? StatKey.CD_BOOST : undefined
      read = (x) =>
        x.getActionValueByIndex(key as StatKeyValue, entityIndex)
        + (boost === undefined ? 0 : x.getActionValueByIndex(boost, entityIndex))
    }
  } else if (option.statKey != null) {
    const key = option.statKey
    read = (x) => x.getActionValueByIndex(key, entityIndex)
  } else if (option.globalRegisterIndex != null) {
    const key = option.globalRegisterIndex
    read = (x) => x.getGlobalRegisterValue(key)
  } else {
    const action = context.defaultActions.find((a) => a.actionName === option.key)
    read = action ? (x) => x.getActionRegisterValue(action.registerIndex) : () => 0
  }
  return { basic, computed: (x: ComputedStatsContainer) => Math.fround(read(x)) }
}
