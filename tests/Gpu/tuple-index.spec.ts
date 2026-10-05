import {
  expect,
  test,
} from '@playwright/test'

test('tuple shader scores sampled boundary workgroups beyond i32 and u32 without index wrap', async ({ page }, testInfo) => {
  await page.goto('/tests/Gpu/')
  await page.waitForFunction(() => !!window.gpuTupleIndexRegression)
  const result = await page.evaluate(() => window.gpuTupleIndexRegression())
  await testInfo.attach('tuple-boundary', { body: JSON.stringify(result), contentType: 'application/json' })
  expect(result.errors).toEqual([])
  expect(result.cases.length).toBeGreaterThan(3)
  for (const entry of result.cases) expect(entry.mismatches, JSON.stringify(entry.firstMismatch)).toBe(0)
})

test('tuple shader applies exact ID tie thresholds within nonzero ornament slices', async ({ page }, testInfo) => {
  await page.goto('/tests/Gpu/')
  await page.waitForFunction(() => !!window.gpuTupleIndexRegression)
  const result = await page.evaluate(() => window.gpuTupleIndexRegression(70000, 70000, true))
  await testInfo.attach('tuple-boundary-ties', { body: JSON.stringify(result), contentType: 'application/json' })
  expect(result.errors).toEqual([])
  expect(result.cases.some((c) => c.range.xp > 0 && c.range.xl > 0)).toBe(true)
  for (const entry of result.cases) expect(entry.mismatches, JSON.stringify(entry.firstMismatch)).toBe(0)
})
