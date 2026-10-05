import { Constants } from 'lib/constants/constants'
import { getCpuActionPlan } from 'lib/optimization/cpuActionPlan'
import { SortOption } from 'lib/optimization/sortOptions'
import type { Form } from 'types/form'
import type { OptimizerContext } from 'types/optimizer'
import {
  expect,
  it,
} from 'vitest'

const context = {
  defaultActions: ['BASIC', 'SKILL', 'ULT'].map((actionName) => ({ actionName })),
  rotationActions: [{}, {}],
} as OptimizerContext
const request = Object.assign(
  { resultSort: 'BASIC', statDisplay: 'combat' },
  ...Object.values(SortOption).map((option) =>
    option.minFilterKey && option.maxFilterKey ? { [option.minFilterKey]: 0, [option.maxFilterKey]: Constants.MAX_INT } : {}
  ),
) as Form
const plan = (patch: Partial<Form> = {}) => getCpuActionPlan({ ...request, ...patch }, context)

it('retains a dependency prefix for later ability filters, including negative bounds', () => {
  expect(plan()).toEqual({ defaultActionCount: 1, rotationActionCount: 0 })
  expect(plan({ minSkill: 1 }).defaultActionCount).toBe(2)
  expect(plan({ maxUlt: 100 }).defaultActionCount).toBe(3)
  expect(plan({ minUlt: -1 }).defaultActionCount).toBe(3)
  expect(plan({ minSpd: 134, statDisplay: 'base' }).defaultActionCount).toBe(1)
})

it('retains the last default action for combat and EHP filters and stat objectives', () => {
  for (const patch of [{ minSpd: 134 }, { maxCr: 0.8 }, { minEhp: 1 }, { resultSort: 'CD' }, { resultSort: 'EHP' }] as Partial<Form>[]) {
    expect(plan(patch)).toEqual({ defaultActionCount: 3, rotationActionCount: 0 })
  }
})

it('omits only unconsumed defaults for rotation damage, heal and shield totals', () => {
  for (const resultSort of ['COMBO', 'COMBO_HEAL', 'COMBO_SHIELD'] as const) {
    expect(plan({ resultSort })).toEqual({ defaultActionCount: 0, rotationActionCount: 2 })
    expect(plan({ resultSort, memoDisplay: 'memo' })).toEqual({ defaultActionCount: 0, rotationActionCount: 2 })
  }
})

it('keeps all actions for buffs, tracing, empty rotations and unavailable ability objectives', () => {
  for (const resultSort of ['COMBO_BUFF', 'MEMO_SKILL'] as const) {
    expect(plan({ resultSort })).toEqual({ defaultActionCount: 3, rotationActionCount: 2 })
  }
  expect(plan({ trace: true })).toEqual({ defaultActionCount: 3, rotationActionCount: 2 })
  expect(plan({ resultSort: 'COMBO', trace: true })).toEqual({ defaultActionCount: 3, rotationActionCount: 2 })
  expect(getCpuActionPlan({ ...request, resultSort: 'COMBO' }, { ...context, rotationActions: [] }))
    .toEqual({ defaultActionCount: 3, rotationActionCount: 0 })
})

it('retains defaults for every active or unspecified numeric filter, including base display', () => {
  for (const filter of Object.values(SortOption)) {
    if (!filter.minFilterKey || !filter.maxFilterKey) continue
    for (const statDisplay of ['base', 'combat'] as const) {
      for (
        const patch of [
          { [filter.minFilterKey]: -1 },
          { [filter.maxFilterKey]: 100 },
          { [filter.minFilterKey]: undefined },
          { [filter.maxFilterKey]: undefined },
          { [filter.minFilterKey]: null },
          { [filter.maxFilterKey]: Number.NaN },
        ]
      ) {
        expect(plan({ resultSort: 'COMBO', statDisplay, ...patch })).toEqual({ defaultActionCount: 3, rotationActionCount: 2 })
      }
    }
  }
})

it('recognizes pairs of absent bounds without treating one-sided filters as disabled', () => {
  for (const filter of Object.values(SortOption)) {
    if (!filter.minFilterKey || !filter.maxFilterKey) continue
    expect(plan({ resultSort: 'COMBO', [filter.minFilterKey]: undefined, [filter.maxFilterKey]: undefined }))
      .toEqual({ defaultActionCount: 0, rotationActionCount: 2 })
  }
})

it('prunes non-COMBO defaults with loaded absent bounds while retaining live dependencies', () => {
  const absent = Object.fromEntries(Object.values(SortOption).flatMap((filter) =>
    filter.minFilterKey && filter.maxFilterKey ? [[filter.minFilterKey, undefined], [filter.maxFilterKey, undefined]] : []
  ))
  expect(plan(absent)).toEqual({ defaultActionCount: 1, rotationActionCount: 0 })
  expect(plan({ ...absent, minUlt: 1 })).toEqual({ defaultActionCount: 3, rotationActionCount: 0 })
  expect(plan({ ...absent, minEhp: 1 })).toEqual({ defaultActionCount: 3, rotationActionCount: 0 })
  expect(plan({ ...absent, maxSpd: 150 })).toEqual({ defaultActionCount: 3, rotationActionCount: 0 })
})
