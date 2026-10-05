import {
  appendMirrorFeedEntry,
  summarizeAutomationValue,
} from 'lib/automation/mirror'
import { expect } from 'vitest'
import { it } from 'vitest'

function event(seq: number, overrides: Partial<Parameters<typeof appendMirrorFeedEntry>[1]> = {}) {
  return {
    seq,
    ts: 1000 + seq,
    name: 'get_job',
    ok: true,
    durationMs: 5,
    input: { jobId: 'job' },
    ...overrides,
  }
}

it('summarizes values with bounded depth, array, string and total sizes', () => {
  const long = 'x'.repeat(500)
  const text = JSON.stringify(summarizeAutomationValue({
    json: long,
    relics: Array.from({ length: 30 }, (_, i) => ({ id: i })),
  }))
  expect(text).toContain('…(+260 chars)')
  expect(text).toContain('…(30 items)')
  expect(text.length).toBeLessThan(4000)
  // Whole-object cap kicks in when the summarized content still exceeds the budget.
  const capped = JSON.stringify(summarizeAutomationValue({ nested: Array.from({ length: 30 }, (_, i) => ({ atk: long, def: long })) }))
  expect(capped).toContain('…(large object, truncated to keys:')
  expect(capped.length).toBeLessThan(4000)
  expect(summarizeAutomationValue('plain')).toBe('plain')
  expect(summarizeAutomationValue(5)).toBe(5)
  expect(summarizeAutomationValue(null)).toBe(null)
})

it('merges consecutive identical polls into one row carrying the latest status', () => {
  let entries = appendMirrorFeedEntry([], event(1, { durationMs: 10 }))
  entries = appendMirrorFeedEntry(entries, event(2, { durationMs: 20, input: { jobId: 'job' } }))
  entries = appendMirrorFeedEntry(entries, event(3, { durationMs: 30, input: { jobId: 'job' }, data: { progress: 99 } }))
  expect(entries).toHaveLength(1)
  expect(entries[0].count).toBe(3)
  expect(entries[0].durationMs).toBe(30)
  expect(entries[0].data).toEqual({ progress: 99 })
})

it('does not merge across different commands, inputs, outcomes or gaps', () => {
  let entries = appendMirrorFeedEntry([], event(1))
  entries = appendMirrorFeedEntry(entries, event(2, { name: 'list_relics', input: { offset: 0 } }))
  expect(entries).toHaveLength(2)
  entries = appendMirrorFeedEntry(entries, event(3, { input: { jobId: 'other' } }))
  expect(entries).toHaveLength(3)
  entries = appendMirrorFeedEntry(entries, event(4, { ok: false, errorCode: 'NOT_COMPLETED' }))
  expect(entries).toHaveLength(4)
  expect(entries[0].count).toBe(1)
})

it('drops duplicate replayed backlog events and caps the feed size', () => {
  let entries = appendMirrorFeedEntry([], event(5))
  entries = appendMirrorFeedEntry(entries, event(5))
  expect(entries).toHaveLength(1)
  for (let seq = 6; seq < 400; seq++) entries = appendMirrorFeedEntry(entries, event(seq, { input: { jobId: 'job-' + seq } }))
  expect(entries).toHaveLength(300)
  expect(entries[0].seq).toBe(399)
})
