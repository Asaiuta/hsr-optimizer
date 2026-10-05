import {
  expect,
  test,
} from '@playwright/test'
import type { Scenario } from './harness'

for (const tuple of [false, true]) {
  for (const objective of ['COMBO', 'BASIC', 'CD'] as const) {
    for (const pieces of [0, 1, 2] as const) {
      test(`${tuple ? 'tuple' : 'naive'} ${objective}, ${pieces} Sigonia pieces`, async ({ page }, testInfo) => {
        await page.goto('/tests/Gpu/')
        await page.waitForFunction(() => typeof window.gpuScoreRegression === 'function')
        expect(await page.evaluate(async () => !!await navigator.gpu?.requestAdapter()), 'A real WebGPU adapter is required').toBe(true)
        const expectedScores: number[] = []
        for (const stacks of [0, 4, 10] as const) {
          const scenario: Scenario = { tuple, objective, pieces, stacks }
          const result = await page.evaluate((input) => window.gpuScoreRegression(input), scenario)
          await testInfo.attach(`stacks-${stacks}`, { body: JSON.stringify({ scenario, ...result }, null, 2), contentType: 'application/json' })
          expect(result.errors).toEqual([])
          expect(result.cycles).toBe(256)
          expect(result.tuple).toBe(tuple)
          expect(result.count).toBe(result.expectedCount)
          expect(result.validCount).toBe(result.expectedCount)
          expect(new Set(result.scores.map((score) => score.index)).size).toBe(result.expectedCount)
          for (const score of result.scores) {
            expect(score.index).toBeGreaterThanOrEqual(tuple ? 0 : 18113941)
            expect(score.index).toBeLessThan(tuple ? 64 : 18113942)
            expect(Number.isFinite(score.value) && Number.isFinite(score.expected)).toBe(true)
            expect(Math.abs(score.value - score.expected) / Math.max(1, Math.abs(score.expected)), JSON.stringify({ scenario, score })).toBeLessThan(1e-5)
          }
          expectedScores.push(result.scores[0].expected)
        }
        if (pieces < 2) {
          expect(expectedScores[1]).toBe(expectedScores[0])
          expect(expectedScores[2]).toBe(expectedScores[0])
        } else {
          expect(expectedScores[1]).toBeGreaterThan(expectedScores[0])
          expect(expectedScores[2]).toBeGreaterThan(expectedScores[1])
          if (objective === 'CD') {
            expect(expectedScores[1] - expectedScores[0]).toBeCloseTo(0.16, 5)
            expect(expectedScores[2] - expectedScores[0]).toBeCloseTo(0.4, 5)
          }
        }
      })
    }
  }
}
