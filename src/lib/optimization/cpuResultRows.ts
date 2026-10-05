import { BasicStatsArrayCore } from 'lib/optimization/basicStatsArray'
import {
  BufferPacker,
  type OptimizerDisplayData,
} from 'lib/optimization/bufferPacker'
import { GlobalRegister } from 'lib/optimization/engine/config/keys'
import { ComputedStatsContainer } from 'lib/optimization/engine/container/computedStatsContainer'
import { initializeContextConditionals } from 'lib/simulations/contextConditionals'
import { simulateBuild } from 'lib/simulations/simulateBuild'
import type { SimulationRelicArrayByPart } from 'lib/simulations/statSimulationTypes'
import type { OptimizerContext } from 'types/optimizer'

/** Rebuild only the final K rows, retaining the existing CPU float32 display format. */
export function createCpuResultRows(indices: readonly number[], relics: SimulationRelicArrayByPart, context: OptimizerContext): OptimizerDisplayData[] {
  initializeContextConditionals(context)
  const c = new BasicStatsArrayCore(false)
  const x = new ComputedStatsContainer()
  x.initializeArrays(context.maxContainerArrayLength, context)
  const buffer = new Float32Array(BufferPacker.createFloatBuffer(1))
  const display = context.defaultActions[context.defaultActions.length - 1].config
  const memoIndex = display.entitiesArray.findIndex((entity) => entity.memosprite)
  return indices.map((index) => {
    let cursor = index
    const take = (length: number) => {
      const offset = cursor % length
      cursor = (cursor - offset) / length
      return offset
    }
    const LinkRope = relics.LinkRope[take(relics.LinkRope.length)]
    const PlanarSphere = relics.PlanarSphere[take(relics.PlanarSphere.length)]
    const Feet = relics.Feet[take(relics.Feet.length)]
    const Body = relics.Body[take(relics.Body.length)]
    const Hands = relics.Hands[take(relics.Hands.length)]
    const Head = relics.Head[take(relics.Head.length)]
    simulateBuild({ Head, Hands, Body, Feet, PlanarSphere, LinkRope }, context, c, x)
    buffer.fill(0)
    BufferPacker.packCharacterContainer(buffer, 0, x, c, context, memoIndex)
    const row = BufferPacker.extractCharacter(buffer, 0, 0)
    // Preserve the global index as a JS number rather than round it through float32.
    row.id = index
    row.COMBO_HEAL = Math.fround(x.getGlobalRegisterValue(GlobalRegister.COMBO_HEAL))
    row.COMBO_SHIELD = Math.fround(x.getGlobalRegisterValue(GlobalRegister.COMBO_SHIELD))
    row.COMBO_BUFF = Math.fround(x.getGlobalRegisterValue(GlobalRegister.COMBO_BUFF))
    return row
  })
}
