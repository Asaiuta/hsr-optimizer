// @vitest-environment jsdom
import { Constants } from 'lib/constants/constants'
import { generateWgsl } from 'lib/gpu/injection/generateWgsl'
import { getGpuActionCount } from 'lib/gpu/injection/gpuActionPlan'
import { generateTestRelics } from 'lib/gpu/tests/webgpuTestUtils'
import type { GpuConstants } from 'lib/gpu/webgpuTypes'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { generateFullDefaultForm } from 'lib/simulations/utils/benchmarkForm'
import { Metadata } from 'lib/state/metadataInitializer'
import { normalizeForm } from 'lib/stores/optimizerForm/optimizerFormConversions'
import type { Form } from 'types/form'
import type { OptimizerContext } from 'types/optimizer'
import {
  describe,
  expect,
  it,
} from 'vitest'

Metadata.initialize()
const gpu = {
  WORKGROUP_SIZE: 256,
  BLOCK_SIZE: 16384,
  CYCLES_PER_INVOCATION: 256,
  RESULTS_LIMIT: 1024,
  COMPACT_LIMIT: 4096,
  DEBUG: false,
  TUPLE_MODE: false,
} satisfies GpuConstants

describe('GPU action dependencies', () => {
  it('retains later rating and displayed-stat dependencies of an early ability objective', () => {
    const context = { defaultActions: ['BASIC', 'SKILL', 'ULT'].map((actionName) => ({ actionName })), rotationActions: [{}, {}] } as OptimizerContext
    const request = { resultSort: 'BASIC', statDisplay: 'combat' } as Form
    expect(getGpuActionCount(request, context, false)).toBe(1)
    expect(getGpuActionCount({ ...request, minSkill: 1 }, context, false)).toBe(2)
    expect(getGpuActionCount({ ...request, maxUlt: 100 }, context, false)).toBe(3)
    expect(getGpuActionCount({ ...request, minSpd: 134 }, context, false)).toBe(3)
    expect(getGpuActionCount({ ...request, minSpd: 134, statDisplay: 'base' }, context, false)).toBe(1)
    expect(getGpuActionCount({ ...request, minEhp: 1, statDisplay: 'base' }, context, false)).toBe(3)
    expect(getGpuActionCount({ ...request, minEhp: 0, maxUlt: Constants.MAX_INT }, context, false)).toBe(1)
    expect(getGpuActionCount(request, context, true)).toBe(5)
  })

  it.each(['ATK', 'DEF', 'HP', 'SPD', 'CR', 'CD', 'EHR', 'RES', 'BE', 'ERR', 'OHB', 'EHP'] as const)(
    'generates a complete default prefix without rotation storage or calls for %s',
    (objective) => {
      const request = normalizeForm(generateFullDefaultForm('8008', '21051', 6, 5))
      request.resultSort = objective
      request.memoDisplay = 'memo'
      request.minUlt = 1
      const context = generateContext(request)
      expect(context.rotationActions.length).toBeGreaterThan(0)
      const shader = generateWgsl(context, request, generateTestRelics(), gpu)
      const count = context.defaultActions.length
      expect(context.shaderVariables.actionLength).toBe(count)
      expect(context.precomputedStatsData!.length).toBe(count * context.maxContainerArrayLength)
      for (let i = 0; i < count; i++) expect(shader).toContain(`fn unrolledAction${i}(`)
      expect(shader).not.toContain(`fn unrolledAction${count}(`)
      expect(shader).not.toContain('(rotation)')
      // Every conditional call must still have a definition after trimming.
      const definitions = new Set([...shader.matchAll(/fn (evaluate\w+)\(/g)].map((match) => match[1]))
      for (const call of shader.matchAll(/\b(evaluate\w+)\(/g)) expect(definitions.has(call[1]), call[1]).toBe(true)
    },
  )

  it.each(['COMBO', 'COMBO_HEAL', 'COMBO_SHIELD', 'COMBO_BUFF'] as const)('keeps the full rotation for %s', (objective) => {
    const request = normalizeForm(generateFullDefaultForm('1313', '23000', 6, 5))
    request.resultSort = objective
    const context = generateContext(request)
    const shader = generateWgsl(context, request, generateTestRelics(), gpu)
    expect(context.shaderVariables.actionLength).toBe(context.allActions.length)
    expect(shader).toContain(`fn unrolledAction${context.allActions.length - 1}(`)
    expect(shader).toContain('comboBuff = defaultComboBuff;')
  })
})
