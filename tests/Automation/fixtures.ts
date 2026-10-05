import {
  expect,
  type Page,
} from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { Character } from '../../src/types/character'
import type { HsrOptimizerSaveFormat } from '../../src/types/store'

const sample = JSON.parse(readFileSync(new URL('../../src/data/sample-save.json', import.meta.url), 'utf8')) as HsrOptimizerSaveFormat
export const character = sample.characters.find((character) => character.id === '1212b1')!
const originalSecond = sample.characters.find((character) => character.id === '1005')!
export const second: Character = { ...originalSecond, id: '1005b1', form: { ...originalSecond.form, characterId: '1005b1' } }
const ids = new Set([...Object.values(character.equipped), ...Object.values(second.equipped)])
export const relics = sample.relics.filter((relic) => ids.has(relic.id)).map((relic) =>
  relic.equippedBy === originalSecond.id ? { ...relic, equippedBy: second.id } : relic
)
export const save = JSON.stringify({ characters: [character, second], relics })
export const settings = {
  keepCurrentRelics: true,
  includeEquippedRelics: true,
  rankFilter: false,
  enhance: 0,
  grade: 2,
  mainBody: [],
  mainFeet: [],
  mainPlanarSphere: [],
  mainLinkRope: [],
  statFilters: { minSpd: null },
  setFilters: { fourPiece: [], twoPieceCombos: [], ornaments: [] },
}
export async function call(page: Page, name: string, input: unknown = {}): Promise<any> {
  return page.evaluate(({ name, input }) => window.hsrAutomation.call(name, input), { name, input })
}
export async function data(page: Page, name: string, input: unknown = {}): Promise<any> {
  const result = await call(page, name, input)
  expect(result.ok, JSON.stringify(result)).toBe(true)
  return result.data
}
export const scan = {
  source: 'HSR-Scanner',
  version: 4,
  build: 'v1.2.0',
  metadata: { uid: 0, trailblazer: 'Stelle' },
  characters: [{ id: '1212', level: 80, eidolon: 1 }],
  light_cones: [{ id: '23014', _uid: 'scan-cone-1', level: 80, superimposition: 1, location: '1212' }],
  gacha: { stellar_jade: 1600, oneric_shards: 0 },
  materials: [{ id: '102', name: 'Special Pass', count: 12 }],
  relics: ['Head', 'Hands', 'Body', 'Feet', 'PlanarSphere', 'LinkRope'].map((slot, index) => ({
    _uid: 'scan-relic-' + index,
    set_id: index < 4 ? '101' : '301',
    slot,
    rarity: 5,
    level: 15,
    location: '1212',
    mainstat: ['HP', 'ATK', 'DEF', 'SPD', 'Ice DMG Boost', 'Break Effect'][index],
    substats: [{ key: 'ATK_', value: 4.32 }, { key: 'HP_', value: 4.32 }, { key: 'CRIT Rate_', value: 3.24 }, { key: 'CRIT DMG_', value: 6.48 }],
  })),
}
