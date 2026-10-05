import {
  expect,
  test,
} from '@playwright/test'

test('automation implementation and schema load only on first use', async ({ page }) => {
  const loaded = new Set<string>()
  page.on('request', (request) => {
    const match = new URL(request.url()).pathname.match(/\/assets\/(api|automation-schema)-[^/]+\.js$/)
    if (match) loaded.add(match[1])
  })
  await page.goto('./')
  expect(await page.evaluate(() => window.hsrAutomation.version)).toBe(1)
  expect([...loaded]).toEqual([])
  expect(await page.evaluate(async () => (await window.hsrAutomation.describe()).map((command) => command.name))).toContain('allocate_batch')
  expect([...loaded].sort()).toEqual(['api', 'automation-schema'])
})
