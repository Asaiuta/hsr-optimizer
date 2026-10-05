import { isCpuFilterDisabled } from 'lib/optimization/cpuFilterBounds'
import {
  type BasicStatsArray,
  BasicStatsArrayCore,
} from 'lib/optimization/basicStatsArray'
import { calculateBaseMultis } from 'lib/optimization/calculateDamage'
import {
  calculateBaseStats,
  calculateBasicEffects,
  calculateBasicSetEffects,
  calculateComputedStats,
  calculateElementalStats,
  calculateRelicStats,
} from 'lib/optimization/calculateStats'
import { resetConditionalState } from 'lib/optimization/conditionalStateUtils'
import { getCpuActionPlan } from 'lib/optimization/cpuActionPlan'
import {
  type BasicStatTransform,
  createCpuResultScore,
  getMemoBasicStatTransform,
} from 'lib/optimization/cpuResultScore'
import {
  GlobalRegister,
  StatKey,
  type StatKeyValue,
} from 'lib/optimization/engine/config/keys'
import { OutputTag } from 'lib/optimization/engine/config/tag'
import {
  ComputedStatsContainer,
  type OptimizerEntity,
} from 'lib/optimization/engine/container/computedStatsContainer'
import {
  calculateEhp,
  getDamageFunction,
} from 'lib/optimization/engine/damage/damageCalculator'
import {
  createResultTieOrder,
  OptimizerResultQueue,
} from 'lib/optimization/resultTieOrder'
import { AbilityMeta } from 'lib/optimization/rotation/turnAbilityConfig'
import {
  computeSetMatchesInPlace,
  emptySetMatches,
  type MutableSetMatches,
} from 'lib/optimization/setMatchState'
import { isSetSolutionValid } from 'lib/optimization/setSolutionBitset'
import {
  SortOption,
} from 'lib/optimization/sortOptions'
import {
  encodeOrnamentSetIndex,
  encodeRelicSetIndex,
  OrnamentSetToIndex,
  RelicSetToIndex,
  type SetsOrnaments,
  type SetsRelics,
} from 'lib/sets/setConfigRegistry'
import { initializeContextConditionals } from 'lib/simulations/contextConditionals'
import type { OptimizerWorkerRelics } from 'lib/worker/optimizerWorkerRelics'
import type { BaseWorkerInput } from 'lib/worker/workerPool'
import type { WorkerType } from 'lib/worker/workerUtils'
import { type Form } from 'types/form'
import { type OptimizerContext } from 'types/optimizer'

export interface OptimizerWorkerInput extends BaseWorkerInput, OptimizerEventData {
  workerType: WorkerType.OPTIMIZER
}

export type OptimizerWorkerResult = {
  /** Interleaved global permutation index and float32-rounded score; 16 bytes per candidate. */
  candidates: Float64Array,
}

type OptimizerEventData = {
  relics: OptimizerWorkerRelics,
  request: Form,
  context: OptimizerContext,
  relicSetSolutions: readonly number[] | Uint32Array,
  ornamentSetSolutions: readonly number[] | Uint32Array,
  permutations: number,
  WIDTH: number,
  skip: number,
}

export function optimizerWorker(e: MessageEvent<OptimizerWorkerInput>) {
  // console.log('Message received from main script', e.data)
  // console.log("Request received from main script", JSON.stringify(e.data.request.characterConditionals, null, 4));

  const data: OptimizerEventData = e.data
  const request: Form = data.request
  const context: OptimizerContext = data.context

  const relics = data.relics
  const resultsLimit = request.resultsLimit ?? 1024
  const results = new OptimizerResultQueue(Math.min(resultsLimit, data.WIDTH), createResultTieOrder(data.relics))
  let threshold = request.resultMinFilter ?? Number.NEGATIVE_INFINITY

  const lSize = relics.LinkRope.length
  const pSize = relics.PlanarSphere.length
  const fSize = relics.Feet.length
  const bSize = relics.Body.length
  const gSize = relics.Hands.length

  const relicSetSolutions = data.relicSetSolutions
  const ornamentSetSolutions = data.ornamentSetSolutions

  const combatDisplay = request.statDisplay === 'combat'
  const baseDisplay = !combatDisplay
  const memoDisplay = request.memoDisplay === 'memo'

  initializeContextConditionals(context)
  const { defaultActionCount, rotationActionCount } = getCpuActionPlan(request, context)

  const limit = Math.min(data.permutations, data.WIDTH)

  const c = new BasicStatsArrayCore(false) as BasicStatsArray
  const x = new ComputedStatsContainer()

  // Initialize arrays once with maximum size (performance optimization)
  x.initializeArrays(context.maxContainerArrayLength, context)

  const displayConfig = context.defaultActions[context.defaultActions.length - 1]?.config
  let memospriteEntityIndex = -1
  if (displayConfig) {
    for (let i = 0; i < displayConfig.entitiesLength; i++) {
      const entity = displayConfig.entitiesArray[i]
      if (entity.memosprite) {
        memospriteEntityIndex = i
        break
      }
    }
  }

  const displayEntityIndex = (memoDisplay && memospriteEntityIndex >= 0) ? memospriteEntityIndex : 0
  const memoEntity = memoDisplay && memospriteEntityIndex >= 0 && displayConfig
    ? displayConfig.entitiesArray[memospriteEntityIndex]
    : undefined
  const score = createCpuResultScore(request, context, displayEntityIndex, memoEntity)

  const failsCombatStatsFilter = combatStatsFilter(request)
  const failsBasicStatsFilter = basicStatsFilter(request, memoEntity)
  const needsEhp = request.trace || request.resultSort === 'EHP' || !isCpuFilterDisabled(request.minEhp, request.maxEhp)
  const failsEhpFilter = ehpFilter(request, displayEntityIndex)
  const failsRatingFilter = ratingFilter(request, context)
  const rotationActionOutputTags = context.rotationActions.map((action) => AbilityMeta[action.actionType].outputTag)
  const defaultActionOutputTags = context.defaultActions.map((action) => AbilityMeta[action.actionType].outputTag)

  const sets = Array.from<number>({ length: 6 })
  const setMatches: MutableSetMatches = emptySetMatches()

  const headSets = relics.Head.map((r) => RelicSetToIndex[r.set as SetsRelics])
  const handSets = relics.Hands.map((r) => RelicSetToIndex[r.set as SetsRelics])
  const bodySets = relics.Body.map((r) => RelicSetToIndex[r.set as SetsRelics])
  const feetSets = relics.Feet.map((r) => RelicSetToIndex[r.set as SetsRelics])
  const sphereSets = relics.PlanarSphere.map((r) => OrnamentSetToIndex[r.set as SetsOrnaments])
  const ropeSets = relics.LinkRope.map((r) => OrnamentSetToIndex[r.set as SetsOrnaments])

  // Decode the batch origin once, without truncating global indices to 32 bits.
  let cursor = data.skip
  let l = cursor % lSize
  cursor = (cursor - l) / lSize
  let p = cursor % pSize
  cursor = (cursor - p) / pSize
  let f = cursor % fSize
  cursor = (cursor - f) / fSize
  let b = cursor % bSize
  cursor = (cursor - b) / bSize
  let g = cursor % gSize
  let h = (cursor - g) / gSize

  for (let col = 0; col < limit; col++) {
    const index = data.skip + col

    if (index >= data.permutations) {
      break
    }

    // Advance before evaluating so every early filter exit still consumes its index.
    if (col > 0 && ++l === lSize) {
      l = 0
      if (++p === pSize) {
        p = 0
        if (++f === fSize) {
          f = 0
          if (++b === bSize) {
            b = 0
            if (++g === gSize) {
              g = 0
              h++
            }
          }
        }
      }
    }

    const head = relics.Head[h]
    const hands = relics.Hands[g]
    const body = relics.Body[b]
    const feet = relics.Feet[f]
    const planarSphere = relics.PlanarSphere[p]
    const linkRope = relics.LinkRope[l]

    const setH = headSets[h]
    const setG = handSets[g]
    const setB = bodySets[b]
    const setF = feetSets[f]
    const setP = sphereSets[p]
    const setL = ropeSets[l]

    const relicSetIndex = encodeRelicSetIndex(setH, setG, setB, setF)
    const ornamentSetIndex = encodeOrnamentSetIndex(setP, setL)

    // Exit early if sets don't match
    const relicValid = isSetSolutionValid(relicSetSolutions, relicSetIndex)
    const ornamentValid = isSetSolutionValid(ornamentSetSolutions, ornamentSetIndex)
    if (!relicValid || !ornamentValid) {
      continue
    }

    sets[0] = setH
    sets[1] = setG
    sets[2] = setB
    sets[3] = setF
    sets[4] = setP
    sets[5] = setL

    computeSetMatchesInPlace(setMatches, sets)
    c.init(relicSetIndex, ornamentSetIndex, setMatches, col)

    calculateBasicSetEffects(c, context, setMatches)
    calculateRelicStats(c, head, hands, body, feet, planarSphere, linkRope)
    calculateBaseStats(c, context)
    calculateElementalStats(c, context)

    // Exit early on base display filters failing
    if (baseDisplay && ((score.basic && score.basic(c.a) < threshold) || failsBasicStatsFilter(c))) {
      continue
    }

    x.setBasic(c)
    x.clearRegisters()

    let comboDmg = 0
    let comboHeal = 0
    let comboShield = 0
    let comboBuff = 0

    // Calculate rotation actions for combo damage
    for (let i = 0; i < rotationActionCount; i++) {
      const action = context.rotationActions[i]
      const actionOutputTag = rotationActionOutputTags[i]
      x.setConfig(action.config)
      resetConditionalState(action)

      x.setPrecompute(action.precomputedStats.a)
      calculateBasicEffects(x, action, context)
      calculateComputedStats(x, action, context)
      calculateBaseMultis(x, action, context)

      let actionOutput = 0
      for (let hitIndex = 0; hitIndex < action.hits!.length; hitIndex++) {
        const hit = action.hits![hitIndex]
        const dmg = getDamageFunction(hit.damageFunctionType).apply(x, action, hitIndex, context)
        x.setHitRegisterValue(hit.registerIndex, dmg)

        if (hit.recorded !== false) {
          if (hit.outputTag === actionOutputTag) {
            if (actionOutputTag === OutputTag.BUFF) {
              actionOutput = dmg
            } else {
              actionOutput += dmg
            }
          }
          if (hit.outputTag === OutputTag.DAMAGE) {
            comboDmg += dmg
          } else if (hit.outputTag === OutputTag.HEAL) {
            comboHeal += dmg
          } else if (hit.outputTag === OutputTag.SHIELD) {
            comboShield += dmg
          } else if (hit.outputTag === OutputTag.BUFF) {
            comboBuff = dmg
          }
        }
      }
      x.setActionRegisterValue(action.registerIndex, actionOutput)
    }

    // Calculate default actions for display stats and store in registers
    for (let i = 0; i < defaultActionCount; i++) {
      const action = context.defaultActions[i]
      const actionOutputTag = defaultActionOutputTags[i]
      x.setConfig(action.config)
      resetConditionalState(action)

      x.setPrecompute(action.precomputedStats.a)
      calculateBasicEffects(x, action, context)
      calculateComputedStats(x, action, context)
      calculateBaseMultis(x, action, context)

      let actionOutput = 0
      for (let hitIndex = 0; hitIndex < action.hits!.length; hitIndex++) {
        const hit = action.hits![hitIndex]
        const dmg = getDamageFunction(hit.damageFunctionType).apply(x, action, hitIndex, context)
        x.setHitRegisterValue(hit.registerIndex, dmg)

        if (hit.recorded !== false) {
          if (hit.outputTag === actionOutputTag) {
            if (actionOutputTag === OutputTag.BUFF) {
              actionOutput = dmg
            } else {
              actionOutput += dmg
            }
          }
          if (hit.outputTag === OutputTag.BUFF) {
            comboBuff = dmg
          }
        }
      }
      x.setActionRegisterValue(action.registerIndex, actionOutput)
    }

    if (needsEhp) calculateEhp(x, context)

    x.setGlobalRegisterValue(GlobalRegister.COMBO_DMG, comboDmg)
    x.setGlobalRegisterValue(GlobalRegister.COMBO_HEAL, comboHeal)
    x.setGlobalRegisterValue(GlobalRegister.COMBO_SHIELD, comboShield)
    x.setGlobalRegisterValue(GlobalRegister.COMBO_BUFF, comboBuff)

    // Combat stats filtering
    if (combatDisplay && failsCombatStatsFilter(x, displayEntityIndex)) {
      continue
    }

    // EHP filtering
    if (failsEhpFilter(x)) {
      continue
    }

    // Rating filters (BASIC, SKILL, ULT, FUA, DOT, BREAK, MEMO_SKILL, MEMO_TALENT)
    if (failsRatingFilter(x)) {
      continue
    }

    // Computed rating threshold filter (rising floor from priority queue)
    const value = score.computed(x)
    if (Number.isNaN(value) || value < threshold) {
      continue
    }

    results.fixedSizePush(index, value)
    if (results.size() >= results.limit) threshold = Math.max(threshold, results.topPriority())
  }

  const retained = results.toResults()
  const candidates = new Float64Array(retained.length * 2)
  retained.forEach(({ index, value }, i) => {
    candidates[2 * i] = index
    candidates[2 * i + 1] = value
  })
  self.postMessage({ candidates }, [candidates.buffer])
}

function addBasicConditionIfNeeded(
  conditions: ((c: BasicStatsArray) => boolean)[],
  statKey: StatKeyValue,
  min: number,
  max: number,
  transform?: BasicStatTransform,
) {
  if (isCpuFilterDisabled(min, max)) return

  if (!transform) {
    conditions.push((c) => c.a[statKey] < min || c.a[statKey] > max)
    return
  }

  const [scale, flat] = transform
  conditions.push((c) => {
    const value = scale * c.a[statKey] + flat
    return value < min || value > max
  })
}

function addCombatConditionIfNeeded(
  conditions: ((x: ComputedStatsContainer, entityIndex: number) => boolean)[],
  statKey: StatKeyValue,
  min: number,
  max: number,
) {
  if (!isCpuFilterDisabled(min, max)) {
    conditions.push((x, entityIndex) => {
      const entityName = x.config.entitiesArray[entityIndex].name
      const value = x.getActionValue(statKey, entityName)
      return value < min || value > max
    })
  }
}

function addCombatBoostedConditionIfNeeded(
  conditions: ((x: ComputedStatsContainer, entityIndex: number) => boolean)[],
  statKey: StatKeyValue,
  boostKey: StatKeyValue,
  min: number,
  max: number,
) {
  if (!isCpuFilterDisabled(min, max)) {
    conditions.push((x, entityIndex) => {
      const entityName = x.config.entitiesArray[entityIndex].name
      const value = x.getActionValue(statKey, entityName) + x.getActionValue(boostKey, entityName)
      return value < min || value > max
    })
  }
}

function basicStatsFilter(request: Form, memoEntity?: OptimizerEntity) {
  const conditions: ((c: BasicStatsArray) => boolean)[] = []
  const add = (statKey: StatKeyValue, min: number, max: number) => {
    addBasicConditionIfNeeded(conditions, statKey, min, max, getMemoBasicStatTransform(statKey, memoEntity))
  }

  add(StatKey.HP, request.minHp, request.maxHp)
  add(StatKey.ATK, request.minAtk, request.maxAtk)
  add(StatKey.DEF, request.minDef, request.maxDef)
  add(StatKey.SPD, request.minSpd, request.maxSpd)
  add(StatKey.CR, request.minCr, request.maxCr)
  add(StatKey.CD, request.minCd, request.maxCd)
  add(StatKey.EHR, request.minEhr, request.maxEhr)
  add(StatKey.RES, request.minRes, request.maxRes)
  add(StatKey.BE, request.minBe, request.maxBe)
  add(StatKey.ERR, request.minErr, request.maxErr)

  return (c: BasicStatsArray) => conditions.some((condition) => condition(c))
}

function combatStatsFilter(request: Form) {
  const conditions: ((x: ComputedStatsContainer, entityIndex: number) => boolean)[] = []

  addCombatConditionIfNeeded(conditions, StatKey.HP, request.minHp, request.maxHp)
  addCombatConditionIfNeeded(conditions, StatKey.ATK, request.minAtk, request.maxAtk)
  addCombatConditionIfNeeded(conditions, StatKey.DEF, request.minDef, request.maxDef)
  addCombatConditionIfNeeded(conditions, StatKey.SPD, request.minSpd, request.maxSpd)
  addCombatBoostedConditionIfNeeded(conditions, StatKey.CR, StatKey.CR_BOOST, request.minCr, request.maxCr)
  addCombatBoostedConditionIfNeeded(conditions, StatKey.CD, StatKey.CD_BOOST, request.minCd, request.maxCd)
  addCombatConditionIfNeeded(conditions, StatKey.EHR, request.minEhr, request.maxEhr)
  addCombatConditionIfNeeded(conditions, StatKey.RES, request.minRes, request.maxRes)
  addCombatConditionIfNeeded(conditions, StatKey.BE, request.minBe, request.maxBe)
  addCombatConditionIfNeeded(conditions, StatKey.ERR, request.minErr, request.maxErr)

  return (x: ComputedStatsContainer, entityIndex: number) => conditions.some((condition) => condition(x, entityIndex))
}

function ehpFilter(request: Form, displayEntityIndex: number) {
  const minEhp = request.minEhp
  const maxEhp = request.maxEhp

  if (isCpuFilterDisabled(minEhp, maxEhp)) {
    return () => false
  }

  return (x: ComputedStatsContainer) => {
    const ehp = x.getActionValueByIndex(StatKey.EHP, displayEntityIndex)
    return ehp < minEhp || ehp > maxEhp
  }
}

function ratingFilter(request: Form, context: OptimizerContext) {
  const conditions: ((x: ComputedStatsContainer) => boolean)[] = []

  for (const sortOption of Object.values(SortOption)) {
    if (!sortOption.minFilterKey || !sortOption.maxFilterKey) continue

    const min = request[sortOption.minFilterKey as keyof Form] as number
    const max = request[sortOption.maxFilterKey as keyof Form] as number
    if (isCpuFilterDisabled(min, max)) continue

    const action = context.defaultActions.find((a) => a.actionName === sortOption.key)
    if (!action) continue

    const registerIndex = action.registerIndex
    conditions.push((x) => {
      const value = x.getActionRegisterValue(registerIndex)
      return value < min || value > max
    })
  }

  if (conditions.length === 0) {
    return () => false
  }

  return (x: ComputedStatsContainer) => conditions.some((condition) => condition(x))
}
