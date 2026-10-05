import {
  COMPUTE_ENGINE_GPU_STABLE,
  Parts,
  PartsArray,
  RelicSetFilterOptions,
  Sets,
} from 'lib/constants/constants'
import { type WorkgroupEntry } from 'lib/gpu/webgpuDataTransform'
import {
  destroyPipeline,
  initializeGpuPipeline,
  submitGpuDispatch,
} from 'lib/gpu/webgpuInternals'
import { decodeTupleGlobalIndex } from 'lib/gpu/webgpuOptimizer'
import type {
  GpuExecutionContext,
  RelicsByPart,
} from 'lib/gpu/webgpuTypes'
import { BasicKey } from 'lib/optimization/basicStatsArray'
import { generateContext } from 'lib/optimization/context/calculateContext'
import { createCpuResultRows } from 'lib/optimization/cpuResultRows'
import {
  generateOrnamentSetSolutions,
  generateRelicSetSolutions,
} from 'lib/optimization/relicSetSolver'
import { Metadata } from 'lib/state/metadataInitializer'
import type { Form } from 'types/form'
import type { Relic } from 'types/relic'
import fixtureJson from './sigonia-fixture.json'

Metadata.initialize()
const fixture = fixtureJson as unknown as { form: Form, relics: Record<Parts, Relic> }

async function run(pSize = 70000, lSize = 70000, ties = false) {
  const form = {
    ...structuredClone(fixture.form),
    resultSort: 'SPD',
    statDisplay: 'base',
    resultsLimit: 1024,
    relicSets: [[RelicSetFilterOptions.relic4Piece, Sets.GuardOfWutheringSnow]],
    ornamentSets: [],
  } as Form
  const relics = Object.fromEntries(PartsArray.map((part) => {
    const count = part === Parts.PlanarSphere ? pSize : part === Parts.LinkRope ? lSize : 1
    const base = structuredClone(fixture.relics[part])
    base.set = part === Parts.PlanarSphere || part === Parts.LinkRope ? Sets.BelobogOfTheArchitects : Sets.GuardOfWutheringSnow
    return [
      part,
      Array.from({ length: count }, (_, i) => ({
        ...base,
        id: `${part}-${i}`,
        equippedBy: undefined,
        condensedStats: [...base.condensedStats!.filter(([key]) => key !== BasicKey.SPD && key !== BasicKey.SPD_P), [
          BasicKey.SPD,
          ties ? 0 : part === Parts.PlanarSphere ? i % 97 : part === Parts.LinkRope ? i % 89 : 0,
        ]],
      })),
    ]
  })) as RelicsByPart
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw Error('No GPU adapter')
  const device = await adapter.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message))
  let gpu: GpuExecutionContext | undefined
  try {
    gpu = await initializeGpuPipeline(
      device,
      relics,
      form,
      generateContext(form),
      pSize * lSize,
      COMPUTE_ENGINE_GPU_STABLE,
      generateRelicSetSolutions(form),
      generateOrnamentSetSolutions(form),
      false,
      true,
    )
    if (!gpu.TUPLE_MODE) throw Error('Expected tuple pipeline')
    const all = gpu.assignments
    const selectedIndices = new Set([0, Math.floor(all.length / 2), all.length - 1])
    for (const boundary of [2 ** 31, 2 ** 32]) {
      const found = all.findIndex((a) => a.startOffset >= boundary)
      if (found >= 0) {
        selectedIndices.add(found)
        if (found) selectedIndices.add(found - 1)
      }
    }
    for (let i = 1; i < all.length; i++) {
      if (all[i].startOffset === 0) {
        selectedIndices.add(i - 1)
        selectedIndices.add(i)
      }
    }
    const selected = [...selectedIndices].sort((a, b) => a - b)
    const zeroSpeed = createCpuResultRows([0], relics, generateContext(form))[0].SPD!
    const cases: {
      assignment: number,
      range: WorkgroupEntry,
      count: number,
      expectedCount: number,
      valid: number,
      mismatches: number,
      firstMismatch?: unknown,
    }[] = []
    for (const assignment of selected) {
      const a = all[assignment]
      const params = new ArrayBuffer(48)
      new Float32Array(params)[0] = ties ? Math.fround(zeroSpeed) : -1
      new Uint32Array(params)[1] = assignment
      const coordinates = (local: number) => {
        const offset = BigInt(a.startOffset) + BigInt(local)
        // Missing origins describe the sealed pre-fix ABI only.
        return [Number(offset / BigInt(a.lSize)) + (a.xp ?? 0), Number(offset % BigInt(a.lSize)) + (a.xl ?? 0)] as const
      }
      const [refP, refL] = coordinates(Math.floor(a.permLimit / 2))
      const preferred = (p: number, l: number) => {
        const pId = relics.PlanarSphere[p].id, refPId = relics.PlanarSphere[refP].id
        return pId < refPId || (pId === refPId && relics.LinkRope[l].id < relics.LinkRope[refL].id)
      }
      let expectedCount = a.permLimit
      if (ties) {
        const u = new Uint32Array(params)
        u.set(gpu.tieOrder.rankTuple(refP * lSize + refL), 4)
        u[10] = 1
        expectedCount = 0
        for (let local = 0; local < a.permLimit; local++) {
          const [p, l] = coordinates(local)
          if (preferred(p, l)) expectedCount++
        }
      }
      submitGpuDispatch(gpu, params, 1, 0)
      const read = gpu.compactReadBuffers[0]
      await read.mapAsync(GPUMapMode.READ)
      try {
        const bytes = read.getMappedRange(), u = new Uint32Array(bytes), f = new Float32Array(bytes)
        const count = u[0], valid = u[u.length - 1]
        let mismatches = 0
        let firstMismatch: unknown
        const seen = new Set<number>()
        for (let i = 0; i < Math.min(count, gpu.COMPACT_LIMIT); i++) {
          const local = u[1 + 2 * i], actual = f[2 + 2 * i]
          const [p, l] = coordinates(local)
          const expected = Math.fround(zeroSpeed + (ties ? 0 : p % 97 + l % 89))
          const index = p * lSize + l
          const decoded = decodeTupleGlobalIndex(local, assignment, all, { lSize, pSize, fSize: 1, bSize: 1, gSize: 1 }, 16)
          if (seen.has(local) || local >= a.permLimit || Math.abs(expected - actual) > 0.0001 || decoded !== index || (ties && !preferred(p, l))) {
            mismatches++
            firstMismatch ??= { local, p, l, expected, actual, index, decoded }
          }
          seen.add(local)
        }
        if (count !== expectedCount || valid !== a.permLimit) {
          mismatches++
          firstMismatch ??= { count, valid, expectedCount, expectedValid: a.permLimit }
        }
        cases.push({ assignment, range: a, count, expectedCount, valid, mismatches, firstMismatch })
      } finally {
        read.unmap()
      }
    }
    return {
      pSize,
      lSize,
      ties,
      total: pSize * lSize,
      assignmentCount: all.length,
      cases,
      errors,
      adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture },
    }
  } finally {
    await device.queue.onSubmittedWorkDone()
    if (gpu) destroyPipeline(gpu)
    device.destroy()
  }
}

declare global {
  interface Window {
    gpuTupleIndexRegression: typeof run
  }
}
window.gpuTupleIndexRegression = run
