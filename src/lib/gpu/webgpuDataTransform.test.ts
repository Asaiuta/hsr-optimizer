import {
  Parts,
  Sets,
  type Sets as SetId,
} from 'lib/constants/constants'
import { FixedSizeNumericMinQueue } from 'lib/dataStructures/fixedSizeMinQueue'
import {
  generateParamsMatrix,
  mergeRelicsIntoArray,
  packRankedRelics,
} from 'lib/gpu/webgpuDataTransform'
import {
  type GpuExecutionContext,
  type RelicsByPart,
} from 'lib/gpu/webgpuTypes'
import {
  SetsOrnamentsNames,
  SetsRelicsNames,
} from 'lib/sets/setConfigRegistry'
import { type Relic } from 'types/relic'
import {
  describe,
  expect,
  it,
} from 'vitest'

function makeSerializableRelic(part: Relic['part'], set: SetId): Relic {
  return {
    part,
    set,
    condensedStats: [],
  } as unknown as Relic
}

describe('GPU relic set serialization', () => {
  it('packs unchanged float bytes and exact u32 ranks without an additional binding', () => {
    const matrix = new Float32Array(Array.from({ length: 24 * 3 }, (_, i) => (i - 3) / 7))
    const ranks = new Uint32Array([2, 0, 1])
    const packed = packRankedRelics(matrix, ranks)
    expect(Array.from(new Float32Array(packed.buffer, 0, matrix.length))).toEqual(Array.from(matrix))
    expect(Array.from(packed.subarray(matrix.length, matrix.length + ranks.length))).toEqual([2, 0, 1])
    expect(packed.byteLength % 16).toBe(0)
  })
  it('serializes valid relic and ornament sets into their unchanged family-local indices', () => {
    const relicSet = Sets.PasserbyOfWanderingCloud
    const ornamentSet = Sets.SpaceSealingStation
    const serialized = mergeRelicsIntoArray({
      Head: [makeSerializableRelic(Parts.Head, relicSet)],
      Hands: [],
      Body: [],
      Feet: [],
      PlanarSphere: [makeSerializableRelic(Parts.PlanarSphere, ornamentSet)],
      LinkRope: [],
    })

    expect(serialized).toHaveLength(48)
    expect(serialized.at(22)).toBe(SetsRelicsNames.indexOf(relicSet))
    expect(serialized.at(46)).toBe(SetsOrnamentsNames.indexOf(ornamentSet))
  })
})

describe('bounded GPU dispatch parameters', () => {
  it('preserves indices beyond u32 across arbitrary splits and clamps the last range', () => {
    const sizes = [101, 95, 44, 49, 107, 127]
    const relics = Object.fromEntries(
      ['LinkRope', 'PlanarSphere', 'Feet', 'Body', 'Hands', 'Head'].map((part, i) => [part, { length: sizes[i] }]),
    ) as RelicsByPart
    const permutations = sizes.reduce((a, b) => a * b, 1)
    const context = {
      BLOCK_SIZE: 131072,
      CYCLES_PER_INVOCATION: 256,
      permutations,
      RESULTS_LIMIT: 1024,
      resultsQueue: new FixedSizeNumericMinQueue(1024),
    } as GpuExecutionContext
    for (const offset of [0, 4096, 2 ** 32 + 12345, permutations - 17]) {
      const params = generateParamsMatrix(offset, relics, context, 123)
      const f32 = new Float32Array(params)
      const u32 = new Uint32Array(params)
      let decoded = 0
      let stride = 1
      for (let i = 0; i < sizes.length; i++) {
        decoded += f32[i] * stride
        stride *= sizes[i]
      }
      expect(decoded).toBe(offset)
      expect(u32[7]).toBe(Math.min(123, permutations - offset))
    }
  })
})
