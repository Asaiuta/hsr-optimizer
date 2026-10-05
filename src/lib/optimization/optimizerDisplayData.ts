import {
  type ElementName,
  ElementToStatKeyDmgBoost,
  Stats,
} from 'lib/constants/constants'
import { BasicKey } from 'lib/optimization/basicStatsArray'
import {
  ElementToBasicKeyDmgBoost,
  type OptimizerDisplayData,
} from 'lib/optimization/bufferPacker'
import {
  GlobalRegister,
  StatKey,
} from 'lib/optimization/engine/config/keys'
import type { ComputedStatsContainer } from 'lib/optimization/engine/container/computedStatsContainer'
import type { OptimizerContext } from 'types/optimizer'

// TODO: This is a temporary tool to rename computed stats variables to fit the optimizer grid
export function formatOptimizerDisplayData(x: ComputedStatsContainer, context: OptimizerContext | null) {
  const c = x.c
  const d: Partial<OptimizerDisplayData> = {
    relicSetIndex: c.relicSetIndex,
    ornamentSetIndex: c.ornamentSetIndex,
    id: c.id,
    WEIGHT: c.weight,
    xa: new Float64Array(x.a),
    ca: new Float32Array(c.a),
    tracedX: x,
  }
  const a = x.a

  // Use direct array access for robustness (c may be deserialized plain object)
  d.HP = c.a[BasicKey.HP]
  d.ATK = c.a[BasicKey.ATK]
  d.DEF = c.a[BasicKey.DEF]
  d.SPD = c.a[BasicKey.SPD]
  d.CR = c.a[BasicKey.CR]
  d.CD = c.a[BasicKey.CD]
  d.EHR = c.a[BasicKey.EHR]
  d.RES = c.a[BasicKey.RES]
  d.BE = c.a[BasicKey.BE]
  d.ERR = c.a[BasicKey.ERR]
  d.OHB = c.a[BasicKey.OHB]

  // TODO
  // d.BASIC = a[StatKey.BASIC_DMG]
  // d.SKILL = a[StatKey.SKILL_DMG]
  // d.ULT = a[StatKey.ULT_DMG]
  // d.FUA = a[StatKey.FUA_DMG]
  // d.MEMO_SKILL = a[StatKey.MEMO_SKILL_DMG]
  // d.MEMO_TALENT = a[StatKey.MEMO_TALENT_DMG]
  // d.DOT = a[StatKey.DOT_DMG]
  // d.BREAK = a[StatKey.BREAK_DMG]
  d.COMBO = x.getGlobalRegisterValue(GlobalRegister.COMBO_DMG)
  d.COMBO_HEAL = x.getGlobalRegisterValue(GlobalRegister.COMBO_HEAL)
  d.COMBO_SHIELD = x.getGlobalRegisterValue(GlobalRegister.COMBO_SHIELD)
  d.COMBO_BUFF = x.getGlobalRegisterValue(GlobalRegister.COMBO_BUFF)
  d.EHP = a[StatKey.EHP]

  d.xHP = a[StatKey.HP]
  d.xATK = a[StatKey.ATK]
  d.xDEF = a[StatKey.DEF]
  d.xSPD = a[StatKey.SPD]
  d.xCR = a[StatKey.CR] + a[StatKey.CR_BOOST]
  d.xCD = a[StatKey.CD] + a[StatKey.CD_BOOST]
  d.xEHR = a[StatKey.EHR]
  d.xRES = a[StatKey.RES]
  d.xBE = a[StatKey.BE]
  d.xERR = a[StatKey.ERR]
  d.xOHB = a[StatKey.OHB]
  d.xELEMENTAL_DMG = a[StatKey.BOOST]

  if (context) {
    const basicElementalBoostKey = ElementToBasicKeyDmgBoost[context.element]
    d.ELEMENTAL_DMG = c.a[basicElementalBoostKey]
    d.mELEMENTAL_DMG = c.a[basicElementalBoostKey]

    switch (context.elementalDamageType) {
      case Stats.Physical_DMG:
        d.xELEMENTAL_DMG += a[StatKey.PHYSICAL_DMG_BOOST]
        break
      case Stats.Fire_DMG:
        d.xELEMENTAL_DMG += a[StatKey.FIRE_DMG_BOOST]
        break
      case Stats.Ice_DMG:
        d.xELEMENTAL_DMG += a[StatKey.ICE_DMG_BOOST]
        break
      case Stats.Lightning_DMG:
        d.xELEMENTAL_DMG += a[StatKey.LIGHTNING_DMG_BOOST]
        break
      case Stats.Wind_DMG:
        d.xELEMENTAL_DMG += a[StatKey.WIND_DMG_BOOST]
        break
      case Stats.Quantum_DMG:
        d.xELEMENTAL_DMG += a[StatKey.QUANTUM_DMG_BOOST]
        break
      case Stats.Imaginary_DMG:
        d.xELEMENTAL_DMG += a[StatKey.IMAGINARY_DMG_BOOST]
        break
    }

    for (const action of context.defaultActions) {
      // @ts-expect-error - action.actionName is a dynamic key that matches OptimizerDisplayData fields (BASIC, SKILL, ULT, etc.)
      d[action.actionName] = x.getActionRegisterValue(action.registerIndex)
    }
  }

  // Memosprite stats
  let memoEntityIndex = -1
  for (let i = 1; i < x.config.entitiesLength; i++) {
    if (x.config.entitiesArray[i].memosprite) {
      memoEntityIndex = i
      break
    }
  }

  if (memoEntityIndex >= 0 && context) {
    const memoEntityConfig = x.config.entitiesArray[memoEntityIndex]
    const memoEntity = memoEntityConfig.name
    const ca = c.a

    // Memosprite basic stats (scaled from summoner's basic stats)
    d.mHP = (memoEntityConfig.memoBaseHpScaling ?? 0) * ca[BasicKey.HP] + (memoEntityConfig.memoBaseHpFlat ?? 0)
    d.mATK = (memoEntityConfig.memoBaseAtkScaling ?? 0) * ca[BasicKey.ATK] + (memoEntityConfig.memoBaseAtkFlat ?? 0)
    d.mDEF = (memoEntityConfig.memoBaseDefScaling ?? 0) * ca[BasicKey.DEF] + (memoEntityConfig.memoBaseDefFlat ?? 0)
    d.mSPD = (memoEntityConfig.memoBaseSpdScaling ?? 0) * ca[BasicKey.SPD] + (memoEntityConfig.memoBaseSpdFlat ?? 0)
    d.mCR = ca[BasicKey.CR]
    d.mCD = ca[BasicKey.CD]
    d.mEHR = ca[BasicKey.EHR]
    d.mRES = ca[BasicKey.RES]
    d.mBE = ca[BasicKey.BE]
    d.mERR = ca[BasicKey.ERR]
    d.mOHB = ca[BasicKey.OHB]

    // Memosprite combat stats
    d.mxHP = x.getActionValue(StatKey.HP, memoEntity)
    d.mxATK = x.getActionValue(StatKey.ATK, memoEntity)
    d.mxDEF = x.getActionValue(StatKey.DEF, memoEntity)
    d.mxSPD = x.getActionValue(StatKey.SPD, memoEntity)
    d.mxCR = x.getActionValue(StatKey.CR, memoEntity) + x.getActionValue(StatKey.CR_BOOST, memoEntity)
    d.mxCD = x.getActionValue(StatKey.CD, memoEntity) + x.getActionValue(StatKey.CD_BOOST, memoEntity)
    d.mxEHR = x.getActionValue(StatKey.EHR, memoEntity)
    d.mxRES = x.getActionValue(StatKey.RES, memoEntity)
    d.mxBE = x.getActionValue(StatKey.BE, memoEntity)
    d.mxERR = x.getActionValue(StatKey.ERR, memoEntity)
    d.mxOHB = x.getActionValue(StatKey.OHB, memoEntity)
    d.mxELEMENTAL_DMG = x.getActionValue(StatKey.BOOST, memoEntity)
      + x.getActionValue(ElementToStatKeyDmgBoost[context.element as ElementName], memoEntity)
    d.mxEHP = x.getActionValue(StatKey.EHP, memoEntity)
  }

  return d as OptimizerDisplayData
}
