import {
  commandSchemas,
  describeCommands,
} from 'lib/automation/contracts'
import {
  expect,
  it,
} from 'vitest'

it('rejects unknown fields, invalid numeric inputs and unbounded result requests', () => {
  expect(commandSchemas.start_optimization.safeParse({ characterId: '1102', settings: { resultsLimit: 100000 } }).success).toBe(false)
  expect(commandSchemas.start_optimization.safeParse({ characterId: '1102', settings: { statFilters: { minSpd: NaN } } }).success).toBe(false)
  expect(commandSchemas.start_optimization.safeParse({ characterId: '1102', settings: { inventedBuff: 999 } }).success).toBe(false)
  expect(commandSchemas.get_results.safeParse({ jobId: 'job', offset: -1 }).success).toBe(false)
})

it('advertises the actual input schemas, including defaults and bounds', () => {
  const tools = describeCommands()
  expect(tools.map((tool) => tool.name)).toEqual(Object.keys(commandSchemas))
  expect(tools.find((tool) => tool.name === 'get_results')?.inputSchema.properties?.limit).toMatchObject({ maximum: 100, default: 20 })
})
