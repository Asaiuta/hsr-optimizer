import {
  COMPUTE_ENGINE_GPU_STABLE,
  Parts,
  PartsArray,
  RelicSetFilterOptions,
  Sets,
} from 'lib/constants/constants'
import {
  destroyPipeline,
  generateExecutionPass,
  initializeGpuPipeline,
  submitGpuDispatch,
} from 'lib/gpu/webgpuInternals'
import {
  runNaiveDispatch,
  runTupleDispatch,
} from 'lib/gpu/webgpuOptimizer'
import type {
  GpuExecutionContext,
  RelicsByPart,
} from 'lib/gpu/webgpuTypes'
import { BasicKey } from 'lib/optimization/basicStatsArray'
import type { OptimizerDisplayData } from 'lib/optimization/bufferPacker'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { createCpuResultRows } from 'lib/optimization/cpuResultRows'
import {
  generateOrnamentSetSolutions,
  generateRelicSetSolutions,
} from 'lib/optimization/relicSetSolver'
import {
  getGridColumn,
  SortOption,
} from 'lib/optimization/sortOptions'
import { Metadata } from 'lib/state/metadataInitializer'
import { useOptimizerDisplayStore } from 'lib/stores/optimizerUI/useOptimizerDisplayStore'
import type { Form } from 'types/form'
import type { Relic } from 'types/relic'
import fixtureJson from './sigonia-fixture.json'

export type Scenario = {
  pieces: 0 | 1 | 2,
  stacks: 0 | 4 | 10,
  objective: 'COMBO' | 'BASIC' | 'CD',
  tuple: boolean,
}

type Fixture = { form: Form, relics: Record<Parts, Omit<Relic, 'equippedBy'>>, counts: Record<Parts, number> }
const fixture = fixtureJson as unknown as Fixture
Metadata.initialize()

async function run(scenario: Scenario) {
  const form = structuredClone(fixture.form)
  form.setConditionals![Sets.SigoniaTheUnclaimedDesolation] = [undefined, scenario.stacks]
  form.resultSort = scenario.objective
  if (scenario.tuple) {
    form.relicSets = [[RelicSetFilterOptions.relic2Plus2Piece, Sets.GuardOfWutheringSnow, Sets.EverGloriousMagicalGirl]]
  }
  // Repeated fixture relics retain the original shader dimensions without retaining an account inventory.
  // Tuple cases use a separate 64-combination fixture so every tuple result can be checked.
  const relics = Object.fromEntries(PartsArray.map((part) => {
    const relic: Relic = { ...structuredClone(fixture.relics[part]), equippedBy: undefined }
    if ((part === Parts.PlanarSphere && scenario.pieces >= 1) || (part === Parts.LinkRope && scenario.pieces === 2)) {
      relic.set = Sets.SigoniaTheUnclaimedDesolation
    }
    return [part, Array.from({ length: scenario.tuple ? 2 : fixture.counts[part] }, (_, i) => ({ ...relic, id: `${part}-${i}` }))]
  })) as RelicsByPart
  const permutations = Object.values(relics).reduce((n, rows) => n * rows.length, 1)
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter unavailable')
  const device = await adapter.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  let pipeline: GpuExecutionContext | undefined
  try {
    pipeline = await initializeGpuPipeline(
      device,
      relics,
      form,
      generateContext(form),
      permutations,
      COMPUTE_ENGINE_GPU_STABLE,
      generateRelicSetSolutions(form),
      generateOrnamentSetSolutions(form),
      false,
      true,
    )
    const offset = scenario.tuple ? 0 : 18113941
    const expectedCount = scenario.tuple ? 64 : 1
    if (scenario.tuple) {
      // A single all-zero-origin assignment makes compact tuple indices equal global indices here.
      if (pipeline.assignments.length !== 1) throw new Error('Fixture must have exactly one tuple assignment')
      const assignment = pipeline.assignments[0]
      if (
        [assignment.xh, assignment.xg, assignment.xb, assignment.xf, assignment.startOffset].some((n) => n !== 0)
        || assignment.permLimit !== expectedCount
      ) throw new Error('Unexpected tuple fixture origin or size')
      const params = new ArrayBuffer(48)
      new Float32Array(params)[0] = -1
      submitGpuDispatch(pipeline, params, pipeline.assignments.length, 0)
    } else {
      generateExecutionPass(pipeline, offset, 0, 1)
    }
    const read = pipeline.compactReadBuffers[0]
    await read.mapAsync(GPUMapMode.READ)
    let scores: { index: number, value: number }[]
    let count: number, validCount: number
    try {
      const mapped = read.getMappedRange(), u32 = new Uint32Array(mapped), f32 = new Float32Array(mapped)
      count = u32[0]
      validCount = u32[u32.length - 1]
      if (count > pipeline.COMPACT_LIMIT) throw new Error(`Unexpected compact overflow: ${count}`)
      scores = Array.from({ length: count }, (_, i) => ({ index: offset + u32[1 + i * 2], value: f32[2 + i * 2] }))
    } finally {
      read.unmap()
    }
    // Fresh full CPU simulation is the oracle; the GPU values above have never passed through outputResults.
    const column = getGridColumn(SortOption[scenario.objective], form.statDisplay, form.memoDisplay) as keyof OptimizerDisplayData
    const rows = createCpuResultRows(scores.map((score) => score.index), relics, generateContext(form))
    return {
      count,
      validCount,
      expectedCount,
      permutations,
      cycles: pipeline.CYCLES_PER_INVOCATION,
      tuple: pipeline.TUPLE_MODE,
      gpu: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
      errors,
      scores: scores.map((score, i) => ({ ...score, expected: rows[i][column] as number })),
    }
  } finally {
    try {
      await device.queue.onSubmittedWorkDone()
    } finally {
      if (pipeline) destroyPipeline(pipeline)
      device.destroy()
    }
  }
}

declare global {
  interface Window {
    gpuScoreRegression: typeof run
  }
}
window.gpuScoreRegression = run

export type TieScenario = { tuple: boolean, reverse: boolean, limit: number, size?: number, pattern?: 'ties' | 'ascending' }

async function runTies(scenario: TieScenario) {
  const size = scenario.size ?? 4
  const strength = new Map<string, number>()
  const form = structuredClone(fixture.form)
  Object.assign(form, { resultSort: 'SPD', statDisplay: 'base', resultsLimit: scenario.limit, optimizationId: 'gpu-tie-regression' })
  form.relicSets = scenario.tuple ? [[RelicSetFilterOptions.relic2Plus2Piece, Sets.GuardOfWutheringSnow, Sets.EverGloriousMagicalGirl]] : []
  form.ornamentSets = scenario.tuple ? [Sets.BelobogOfTheArchitects] : []
  const relics = Object.fromEntries(PartsArray.map((part) => {
    const outer = PartsArray.indexOf(part) < 4
    const choices = Array.from({ length: size }, (_, i) => ({
      ...structuredClone(fixture.relics[part]),
      equippedBy: undefined,
      id: `${part}-${['z', 'A', '2', '10'][i % 4]}-${i}`,
      set: outer ? (i % 2 ? Sets.GuardOfWutheringSnow : Sets.EverGloriousMagicalGirl) : (i % 2 ? Sets.BelobogOfTheArchitects : Sets.FleetOfTheAgeless),
    }))
    for (let i = 0; i < choices.length; i++) {
      const points = scenario.pattern === 'ascending' && part === Parts.Head ? i : 0
      strength.set(choices[i].id, points)
      if (part === Parts.Head && scenario.pattern === 'ascending') {
        choices[i].condensedStats = [...choices[i].condensedStats!.filter(([key]) => key !== BasicKey.SPD), [BasicKey.SPD, points]]
      }
    }
    return [part, scenario.reverse ? choices.reverse() : choices]
  })) as RelicsByPart
  const device = await (await navigator.gpu.requestAdapter())!.requestDevice()
  let dispatches = 0
  const submit = device.queue.submit.bind(device.queue)
  device.queue.submit = (commands) => {
    dispatches++
    submit(commands)
  }
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  let pipeline: GpuExecutionContext | undefined
  useOptimizerDisplayStore.setState({ optimizationId: form.optimizationId, optimizationInProgress: true })
  try {
    pipeline = await initializeGpuPipeline(
      device,
      relics,
      form,
      generateContext(form),
      size ** 6,
      COMPUTE_ENGINE_GPU_STABLE,
      generateRelicSetSolutions(form),
      generateOrnamentSetSolutions(form),
      false,
      true,
    )
    // Independent six-slot oracle, after tuple's in-place inventory sorting.
    const expected: { index: number, ids: string[] }[] = []
    function visit(slot: number, index: number, pieces: Relic[]) {
      if (slot < 6) {
        relics[PartsArray[slot]].forEach((r, i) => visit(slot + 1, index * size + i, [...pieces, r]))
      } else {
        if (
          scenario.tuple && (pieces.slice(0, 4).filter((r) => r.set === Sets.GuardOfWutheringSnow).length !== 2
            || pieces[4].set !== Sets.BelobogOfTheArchitects || pieces[5].set !== Sets.BelobogOfTheArchitects)
        ) return
        expected.push({ index, ids: pieces.map((r) => r.id) })
      }
    }
    visit(0, 0, [])
    expected.sort((a, b) => {
      const score = strength.get(b.ids[0])! - strength.get(a.ids[0])!
      if (score !== 0) return score
      for (let slot = 0; slot < 6; slot++) if (a.ids[slot] !== b.ids[slot]) return a.ids[slot] < b.ids[slot] ? -1 : 1
      return 0
    })
    const searchStart = performance.now()
    const searched = await (scenario.tuple ? runTupleDispatch(pipeline) : runNaiveDispatch(pipeline))
    const searchMs = performance.now() - searchStart
    const results = pipeline.resultsQueue.toResults().sort(pipeline.tieOrder.compareResults)
    return {
      errors,
      searched,
      eligible: expected.length,
      indices: results.map((r) => r.index),
      expected: expected.slice(0, scenario.limit).map((r) => r.index),
      values: [...new Set(results.map((r) => r.value))],
      maxStorageBuffers: device.limits.maxStorageBuffersPerShaderStage,
      searchMs,
      dispatches,
    }
  } finally {
    useOptimizerDisplayStore.setState({ optimizationInProgress: false })
    await device.queue.onSubmittedWorkDone()
    if (pipeline) destroyPipeline(pipeline)
    device.destroy()
  }
}

declare global {
  interface Window {
    gpuTieRegression: typeof runTies
  }
}
window.gpuTieRegression = runTies

async function runDebugLayout() {
  const form = structuredClone(fixture.form)
  const relics = Object.fromEntries(PartsArray.map((part) => [part, [{ ...structuredClone(fixture.relics[part]), equippedBy: undefined }]])) as RelicsByPart
  const device = await (await navigator.gpu.requestAdapter())!.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message))
  let pipeline: GpuExecutionContext | undefined
  try {
    pipeline = await initializeGpuPipeline(
      device,
      relics,
      form,
      generateContext(form),
      1,
      COMPUTE_ENGINE_GPU_STABLE,
      generateRelicSetSolutions(form),
      generateOrnamentSetSolutions(form),
      true,
      true,
    )
    const pass = generateExecutionPass(pipeline, 0, 0, 1)
    await pass.gpuReadBuffer.mapAsync(GPUMapMode.READ)
    pass.gpuReadBuffer.unmap()
    return { errors, debug: pipeline.DEBUG, pruning: !!pipeline.shieldBound }
  } finally {
    await device.queue.onSubmittedWorkDone()
    if (pipeline) destroyPipeline(pipeline)
    device.destroy()
  }
}
declare global {
  interface Window {
    gpuDebugLayoutRegression: typeof runDebugLayout
  }
}
window.gpuDebugLayoutRegression = runDebugLayout
