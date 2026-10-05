import {
  ABILITY_LIMIT,
  Constants,
  PathNames,
  TwoPieceStatTags,
} from 'lib/constants/constants'
import { AbilityNameToTurnAbility } from 'lib/optimization/rotation/turnAbilityConfig'
import { SortOption } from 'lib/optimization/sortOptions'
import {
  OrnamentSetToIndex,
  RelicSetToIndex,
} from 'lib/sets/setConfigRegistry'
import { z } from 'zod'

const id = z.string().min(1).max(128)
const number = z.number().finite()
const nonnegative = number.nonnegative()
const conditional = z.record(z.string().max(128), z.union([z.boolean(), number]))
const statKeys = [
  'minAtk',
  'maxAtk',
  'minHp',
  'maxHp',
  'minDef',
  'maxDef',
  'minSpd',
  'maxSpd',
  'minCr',
  'maxCr',
  'minCd',
  'maxCd',
  'minEhr',
  'maxEhr',
  'minRes',
  'maxRes',
  'minBe',
  'maxBe',
  'minErr',
  'maxErr',
] as const
const bound = nonnegative.nullable().optional()
const statFilters = z.strictObject(Object.fromEntries(statKeys.map((key) => [key, bound])) as Record<typeof statKeys[number], typeof bound>)
const relicSet = z.enum(Object.keys(RelicSetToIndex))
const ornamentSet = z.enum(Object.keys(OrnamentSetToIndex))
const slot = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('Any') }),
  z.strictObject({ type: z.literal('Set'), value: relicSet }),
  z.strictObject({ type: z.literal('Stat'), value: z.enum(TwoPieceStatTags) }),
])
const teammate = z.strictObject({
  characterId: id,
  characterEidolon: z.int().min(0).max(6).optional(),
  lightCone: id.optional(),
  lightConeSuperimposition: z.int().min(1).max(5).optional(),
  teamRelicSet: relicSet.optional(),
  teamOrnamentSet: ornamentSet.optional(),
  characterConditionals: conditional.optional(),
  lightConeConditionals: conditional.optional(),
})

export const settingsSchema = z.strictObject({
  characterEidolon: z.int().min(0).max(6).optional(),
  lightCone: id.optional(),
  lightConeSuperimposition: z.int().min(1).max(5).optional(),
  teammates: z.array(teammate.nullable()).length(3).optional(),
  statFilters: statFilters.optional().describe(
    'Same units as UI: minCr=70 means 70%; minSpd=134 means 134 SPD. Null clears a saved bound. Applies to statDisplay.',
  ),
  statDisplay: z.enum(['base', 'combat']).optional(),
  resultSort: z.enum(Object.keys(SortOption)).optional(),
  resultsLimit: z.int().min(1).max(100).optional(),
  enhance: z.int().min(0).max(15).optional(),
  grade: z.int().min(2).max(5).optional(),
  rankFilter: z.boolean().optional(),
  includeEquippedRelics: z.boolean().optional(),
  keepCurrentRelics: z.boolean().optional(),
  exclude: z.array(id).max(200).optional(),
  mainBody: z.array(z.enum(Object.values(Constants.MainStats))).max(20).optional(),
  mainFeet: z.array(z.enum(Object.values(Constants.MainStats))).max(20).optional(),
  mainPlanarSphere: z.array(z.enum(Object.values(Constants.MainStats))).max(20).optional(),
  mainLinkRope: z.array(z.enum(Object.values(Constants.MainStats))).max(20).optional(),
  mainStatUpscaleLevel: z.int().min(0).max(15).optional(),
  setFilters: z.strictObject({
    fourPiece: z.array(relicSet).max(100),
    twoPieceCombos: z.array(z.strictObject({ a: slot, b: slot })).max(100),
    ornaments: z.array(ornamentSet).max(100),
  }).optional(),
  enemyCount: z.int().min(1).max(5).optional(),
  enemyLevel: z.int().min(1).max(100).optional(),
  enemyResistance: nonnegative.max(1).optional(),
  enemyElementalWeak: z.boolean().optional(),
  enemyWeaknessBroken: z.boolean().optional(),
  characterConditionals: conditional.optional(),
  lightConeConditionals: conditional.optional(),
  rotation: z.array(z.enum(Object.keys(AbilityNameToTurnAbility))).min(1).max(ABILITY_LIMIT).optional()
    .describe('Explicit action sequence, e.g. DEFAULT_SKILL, DEFAULT_ULT. Replaces the saved rotation and resets per-turn overrides.'),
})

const name = z.string().trim().min(1).max(100)
export const requestSchema = z.strictObject({ characterId: id, buildName: name.optional(), settings: settingsSchema.optional() })
const page = { offset: z.int().min(0).default(0), limit: z.int().min(1).max(100).default(20) }
const empty = z.strictObject({})
const json = z.string().max(32 * 1024 * 1024)
const relicIds = z.array(id).length(6)
export const virtualRelicSchema = z.strictObject({
  part: z.enum(Constants.Parts),
  set: z.enum(Constants.Sets),
  grade: z.int().min(2).max(5).default(5),
  enhance: z.int().min(0).max(15).default(15),
  mainStat: z.enum(Constants.MainStats),
  substats: z.array(z.strictObject({ stat: z.enum(Constants.SubStats), value: nonnegative })).max(4),
})
export const simulationSchema = requestSchema.extend({ relicIds: relicIds.optional(), virtualRelics: z.array(virtualRelicSchema).length(6).optional() })
  .refine((input) => !input.relicIds || !input.virtualRelics, 'Choose relicIds or virtualRelics')
const assignment = z.strictObject({ characterId: id, name: name.optional(), relicIds: relicIds.optional() })
  .refine((input) => Number(!!input.name) + Number(!!input.relicIds) === 1, 'Provide exactly one of name or relicIds')
const assignments = z.array(assignment).min(1).max(32)
const engine = z.enum(['cpu', 'gpu']).default('cpu')

export const commandSchemas = {
  list_characters: z.strictObject({ includeUnimported: z.boolean().default(false) }),
  list_relics: z.strictObject({ ...page, equippedBy: id.optional(), part: z.enum(Object.values(Constants.Parts)).optional() }),
  list_light_cones: z.strictObject({ ...page, path: z.enum(PathNames).optional(), ownedOnly: z.boolean().default(false) }),
  get_resources: z.strictObject(page),
  get_request: requestSchema,
  simulate_build: simulationSchema,
  compare_builds: z.strictObject({ baseline: simulationSchema, candidates: z.array(simulationSchema).min(1).max(20) }),
  start_optimization: requestSchema.extend({ engine }),
  get_job: z.strictObject({ jobId: id }),
  get_results: z.strictObject({ jobId: id, ...page }),
  cancel_job: z.strictObject({ jobId: id }),
  save_result: z.strictObject({ jobId: id, index: z.int().min(0).max(99), name }),
  list_builds: z.strictObject({ characterId: id, ...page }),
  save_build: requestSchema.extend({ name, relicIds: relicIds.optional() }),
  delete_build: z.strictObject({ characterId: id, name }),
  check_builds: z.strictObject({ assignments }),
  equip_builds: z.strictObject({ assignments, expectedRevision: z.int().min(0), onConflict: z.enum(['reject', 'transfer']).default('reject') }),
  import_save: z.strictObject({ json }),
  import_scan: z.strictObject({ json }),
  compare_inventory: z.strictObject({ json, ...page }),
  export_save: empty,
  start_batch: z.strictObject({ requests: z.array(requestSchema).min(1).max(32), engine }),
  get_batch: z.strictObject({ batchId: id }),
  get_batch_results: z.strictObject({ batchId: id, requestIndex: z.int().min(0).max(31), ...page }),
  cancel_batch: z.strictObject({ batchId: id }),
  save_batch_result: z.strictObject({ batchId: id, requestIndex: z.int().min(0).max(31), index: z.int().min(0).max(99), name }),
  allocate_batch: z.strictObject({
    batchId: id,
    weights: z.array(number.positive().max(1000)).min(1).max(32).optional(),
    maxNodes: z.int().min(1).max(1000000).default(100000),
  }),
} as const

export type CommandName = keyof typeof commandSchemas
export type RequestInput = z.infer<typeof requestSchema>
export type AutomationResponse = { ok: true, data: unknown } | { ok: false, error: { code: string, message: string } }

const descriptions: Record<CommandName, string> = {
  list_characters: 'List imported characters, names and current equipment. No network requests.',
  list_light_cones: 'List light cone metadata, or owned scanner light cones. Owned inventory is unavailable until a scan is imported.',
  get_resources: 'Read scanner funds and a page of materials, plus saved warp planner settings. Missing scanner resources are unknown, not zero.',
  list_relics: 'Read a bounded page of relics, optionally filtered by owner or slot.',
  get_request: 'Inspect normalized settings before simulation/search. Omitted settings use saved character defaults. Percent filters use UI units.',
  simulate_build: 'Simulate six existing relics, or currently equipped relics. Returns numerical output; does not change equipment.',
  compare_builds: 'Compare numerical stats and rotation totals against a baseline. Supports virtual relics and explicit rotations. No inventory mutations.',
  start_optimization:
    'Start one search and return its job ID immediately. Rejects concurrent searches. Read get_job, then get_results. Keeps only the latest job.',
  get_job: 'Get job status, progress and inventory freshness. Completed means results have been committed. A failed or cancelled search is not an optimum.',
  get_results: 'Read a bounded page of completed search results with exact relic IDs and numerical stats.',
  cancel_job: 'Cancel this job only. Cannot cancel a different or superseding UI search.',
  save_result: 'Save a named optimizer build from a completed result. Rejects stale inventory and duplicate names. Does not equip relics or modify the game.',
  list_builds: 'Read saved build settings and relic IDs, including missing relics and ownership conflicts.',
  save_build: 'Save current or specified existing relics and resolved settings as a named build. Never overwrites an existing name.',
  delete_build: 'Delete exactly one named optimizer build. Does not remove characters or relics.',
  check_builds: 'Preview multiple assignments: report shared relics and relics owned by other characters, without changing equipment.',
  equip_builds:
    'Apply a validated set of assignments inside the optimizer. Requires the revision returned by check_builds. Transfer explicitly unequips outside owners; duplicate assignments always fail. Does not operate the game.',
  import_save: 'Replace optimizer data with an exported optimizer JSON save. Scanner formats are not accepted by this command.',
  import_scan:
    'Import a supported scanner file using the existing parser and inventory merge. Rejects partial parse failures. Keeps character settings/builds and records scanner resource inventory.',
  compare_inventory: 'Compare a previous optimizer save with current inventory by stable IDs. Read-only paged additions, removals and field changes.',
  export_save: 'Export optimizer save as JSON text.',
  start_batch: 'Sequentially optimize up to 32 scenarios using one worker pool. Retains bounded results for this batch. Does not equip or reserve relics.',
  get_batch: 'Read per-scenario status of the latest batch. Inventory changes or an interrupted search stop the batch.',
  get_batch_results: 'Read a page of results for a completed scenario in the latest batch.',
  cancel_batch: 'Cancel the active batch and its current search, preserving already completed scenario results.',
  save_batch_result: 'Save a named build from a completed batch scenario. Rejects stale inventory.',
  allocate_batch:
    'Find a conflict-free assignment across one completed batch scenario per character. Maximizes weighted scores normalized to each scenario best. Bounded branch-and-bound; reports whether the candidate search was exhausted. Does not claim a global optimum outside retained candidates or equip builds.',
}

export function describeCommands() {
  return Object.entries(commandSchemas).map(([name, schema]) => ({
    name,
    description: descriptions[name as CommandName],
    inputSchema: z.toJSONSchema(schema, { io: 'input' }),
  }))
}

export class AutomationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}
