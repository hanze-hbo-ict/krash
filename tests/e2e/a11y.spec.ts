/** Automated accessibility checks (axe) on the main states, plus workspace clearing. */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function open(page: Page) {
  await page.goto('/')
  await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const summary = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(summary).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test(`no axe violations with results and an error (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await open(page)
    await page.locator('.schema-tree summary').filter({ hasText: 'people' }).click()
    await page.locator('.cm-content').click()
    await page.keyboard.insertText("select id, name, born from people order by id;\nselect 1/0;")
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(page.locator('#results-body').getByRole('alert')).toBeVisible()
    await axe(page)
    await page.getByRole('button', { name: 'Import database' }).click()
    await axe(page)
  })
}

test('keyboard only: run, switch tabs and resize without a mouse', async ({ page }) => {
  await open(page)
  await page.locator('.cm-content').focus()
  await page.keyboard.insertText('select 1 as one;')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(page.locator('#results-body tbody td').first()).toHaveText('1')
  await page.getByRole('button', { name: 'New query tab' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: 'Query 2' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Query 2' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Query 1' })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'Query 1' })).toHaveAttribute('aria-selected', 'true')
  const sep = page.getByRole('separator', { name: 'Resize editor and results' })
  await sep.focus()
  const before = Number(await sep.getAttribute('aria-valuenow'))
  await page.keyboard.press('ArrowDown')
  await expect(sep).toHaveAttribute('aria-valuenow', String(before + 5))
})

test('Clear workspace removes answers and the database, then starts fresh', async ({ page }) => {
  await open(page)
  await page.locator('.cm-content').click()
  await page.keyboard.insertText('create table gone_t (x int);')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.schema-tree').getByText('gone_t', { exact: true })).toBeVisible()
  const before = await page.evaluate(() => JSON.parse(sessionStorage.getItem('krash:v1:workspace')!).dbName as string)

  await page.getByRole('button', { name: 'Clear workspace' }).click()
  await page.getByRole('dialog', { name: 'Clear this workspace?' }).getByRole('button', { name: 'Clear workspace' }).click()
  await page.waitForLoadState('load')
  await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
  await expect(page.locator('.schema-tree').getByText('gone_t', { exact: true })).toHaveCount(0)
  await expect(page.locator('.cm-content')).toHaveText('')
  const after = await page.evaluate(() => JSON.parse(sessionStorage.getItem('krash:v1:workspace')!).dbName as string)
  expect(after).not.toBe(before)
  const names = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  expect(names).not.toContain(`/pglite/${before}`)
})
