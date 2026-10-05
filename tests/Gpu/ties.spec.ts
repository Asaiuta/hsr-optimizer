import {
  expect,
  test,
} from '@playwright/test'

test('DEBUG retains its original binding layout and full-stat output', async ({ page }) => {
  await page.goto('/tests/Gpu/')
  await page.waitForFunction(() => typeof window.gpuDebugLayoutRegression === 'function')
  expect(await page.evaluate(() => window.gpuDebugLayoutRegression())).toEqual({ errors: [], debug: true, pruning: false })
})

for (const tuple of [false, true]) {
  for (const limit of [1, 7, 1024, 5000]) {
    test(`${tuple ? 'tuple' : 'naive'} stable ties K=${limit}, both inventory orders, storage fallback`, async ({ page }, testInfo) => {
      // Exercise the compatibility path at the default eight storage-binding limit.
      await page.addInitScript(() => Object.defineProperty(navigator.gpu, 'wgslLanguageFeatures', { value: new Set(), configurable: true }))
      await page.goto('/tests/Gpu/')
      await page.waitForFunction(() => typeof window.gpuTieRegression === 'function')
      for (const reverse of [false, true]) {
        const result = await page.evaluate((scenario) => window.gpuTieRegression(scenario), { tuple, limit, reverse })
        await testInfo.attach(`reverse-${reverse}`, { body: JSON.stringify(result), contentType: 'application/json' })
        expect(result.errors).toEqual([])
        expect(result.maxStorageBuffers).toBe(8)
        expect(result.indices).toEqual(result.expected)
        expect(result.indices.length).toBe(Math.min(limit, result.eligible))
        expect(result.values).toHaveLength(1)
        expect(result.searched).toBe(result.eligible)
      }
    })
  }
}
