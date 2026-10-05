import { z } from 'zod'

const id = z.string().min(1).max(128)
const count = z.number().finite().nonnegative()
const location = z.string().max(128).default('')
const substat = z.looseObject({ key: id, value: count, count: count.optional(), step: count.optional() })
export const scannerConeSchema = z.looseObject({
  id,
  _uid: id,
  name: z.string().default(''),
  level: z.int().min(1).max(80),
  ascension: z.int().min(0).max(6).default(6),
  superimposition: z.int().min(1).max(5),
  location,
  lock: z.boolean().default(false),
})
const material = z.looseObject({ id, name: z.string(), count, expire_time: count.optional() })
const gacha = z.looseObject({ stellar_jade: count, oneric_shards: count })
export const scannerInventorySchema = z.object({
  source: id,
  gacha: gacha.nullable(),
  materials: z.array(material).max(10000),
  lightCones: z.array(scannerConeSchema).max(5000),
})
export const scanSchema = z.looseObject({
  source: id,
  version: z.int(),
  build: z.string().default('v0.0.0'),
  metadata: z.looseObject({ uid: z.number().optional(), trailblazer: z.enum(['Stelle', 'Caelus']).default('Stelle') }).default({ trailblazer: 'Stelle' }),
  characters: z.array(z.looseObject({
    id,
    name: z.string().default(''),
    path: z.string().default(''),
    level: z.int().min(1).max(80),
    ascension: z.int().min(0).max(6).default(6),
    eidolon: z.int().min(0).max(6),
    ability_version: z.int().min(0).optional(),
  })).max(200).default([]),
  light_cones: z.array(scannerConeSchema).max(5000).default([]),
  relics: z.array(z.looseObject({
    _uid: id,
    set_id: id,
    name: z.string().default(''),
    slot: id,
    rarity: z.int().min(2).max(5),
    level: z.int().min(0).max(15),
    mainstat: id,
    substats: z.array(substat).max(4),
    preview_substats: z.array(substat).max(4).optional(),
    reroll_substats: z.array(substat).max(4).optional(),
    location,
    lock: z.boolean().default(false),
    discard: z.boolean().default(false),
  })).max(10000),
  materials: z.array(material).max(10000).default([]),
  gacha: gacha.optional(),
})
