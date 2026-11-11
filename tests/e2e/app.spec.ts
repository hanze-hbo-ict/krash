/**
 * Critical end-to-end acceptance scenarios (see PLAN.md §7).
 * Runs against the production build (vite preview) in Chromium, Firefox and WebKit.
 */
import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function open(page: Page) {
  await page.goto('/')
  await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
}

/** Replace the active editor's text exactly (no auto-indent). */
async function setSql(page: Page, sql: string) {
  const content = page.locator('.cm-content')
  await content.click()
  await page.keyboard.press(`${MOD}+A`)
  await page.keyboard.press('Backspace')
  if (sql) await page.keyboard.insertText(sql)
}

async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent ?? '')
    return lines.join('\n')
  })
}

async function run(page: Page) {
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.db-status')).not.toHaveText('Running…')
}

const results = (page: Page) => page.locator('#results-body')

test.describe('Krash', () => {
  test('1–2: fresh workspace shows seeded schema; SELECT and DDL work', async ({ page }) => {
    await open(page)
    const tree = page.locator('.schema-tree')
    await expect(tree.getByText('customers', { exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Question 1' })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => editorText(page)).toBe('')

    await setSql(page, 'select count(*) as n from customers;')
    await run(page)
    await expect(results(page).locator('table td').first()).toHaveText('30')
    await expect(results(page).locator('th').filter({ hasText: /^n/ })).toBeVisible()

    await setSql(page, 'create table answers_t (id int primary key, label text not null);\ninsert into answers_t values (1, \'a\');\nselect * from answers_t where false;')
    await run(page)
    await expect(tree.getByText('answers_t', { exact: true })).toBeVisible()
    // Empty result still shows column headers.
    await expect(results(page).locator('thead th').filter({ hasText: 'label' })).toBeVisible()
    await expect(results(page).getByText('No rows.')).toBeVisible()
  })

  test('3: multi-statement script with comments, string semicolons and dollar quoting runs intact', async ({ page }) => {
    await open(page)
    const script = [
      '-- comment; with semicolon',
      "create table s3 (v text);",
      "insert into s3 values ('a;b'), ($$c;d$$);",
      '/* block; comment */',
      'create function s3_count() returns bigint language plpgsql as $fn$',
      'begin',
      '  return (select count(*) from s3); -- inner;',
      'end;',
      '$fn$;',
      'select v, s3_count() from s3 order by v;',
    ].join('\n')
    await setSql(page, script)
    await run(page)
    const table = results(page).locator('table')
    await expect(table.locator('tbody tr')).toHaveCount(2)
    await expect(table.locator('tbody tr').first().locator('td').first()).toHaveText('a;b')
    await expect(page.getByRole('tab', { name: 'Result · 2 rows' })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => editorText(page)).toBe(script)
  })

  test('4: errors are genuine, located, and keep the SQL intact', async ({ page }) => {
    await open(page)
    const sql = 'select 1;\nselect *\n  fromm customers;'
    await setSql(page, sql)
    await run(page)
    const alert = results(page).getByRole('alert')
    await expect(alert).toContainText('syntax error at or near "fromm"')
    await expect(alert).toContainText('Line 3, column 3')
    await expect(alert).toContainText('SQLSTATE 42601')
    await expect.poll(() => editorText(page)).toBe(sql)
    await setSql(page, 'select * from customers\nwhere id = 1;')
    await run(page)
    await expect(results(page).getByRole('alert')).toHaveCount(0)
    await expect(results(page).locator('tbody tr')).toHaveCount(1)
  })

  test('5: Ctrl/Cmd+Enter runs only the selection', async ({ page }) => {
    await open(page)
    await setSql(page, 'select 111 as first;\nselect 222 as second;')
    // Select the second line with the keyboard.
    await page.keyboard.press(`${MOD}+End`)
    await page.keyboard.press('Shift+Home')
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(page.locator('.db-status')).toHaveText('Ready')
    await expect(results(page).locator('tbody td').first()).toHaveText('222')
    await expect(page.getByRole('tab', { name: /Result · 1 row/ })).toBeVisible()
    await expect(page.locator('.run-meta')).toContainText('(selection)')
  })

  test('6–7: three tabs share one database; answers and DB survive a reload without re-seeding', async ({ page }) => {
    await open(page)
    await setSql(page, 'create table shared_t (n int);')
    await run(page)
    await page.getByRole('tab', { name: 'Question 2' }).click()
    await setSql(page, 'insert into shared_t values (42);')
    await run(page)
    await page.getByRole('tab', { name: 'Question 3' }).click()
    await setSql(page, 'select n from shared_t;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('42')

    await page.getByRole('tab', { name: 'Question 1' }).click()
    await expect.poll(() => editorText(page)).toBe('create table shared_t (n int);')

    await page.waitForTimeout(600) // debounce
    await page.reload()
    await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
    await expect(page.getByText('Welcome back')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Question 1' })).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => editorText(page)).toBe('create table shared_t (n int);')
    await page.getByRole('tab', { name: 'Question 3' }).click()
    await expect.poll(() => editorText(page)).toBe('select n from shared_t;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('42')
  })

  test('8: a new tab gets its own fresh database and empty answers', async ({ page, context }) => {
    await open(page)
    await setSql(page, 'create table only_here (x int);')
    await run(page)
    const other = await context.newPage()
    await open(other)
    await expect.poll(() => editorText(other)).toBe('')
    await setSql(other, "select to_regclass('only_here') is null as absent;")
    await run(other)
    await expect(results(other).locator('tbody td').first()).toHaveText('t')
  })

  test('8b: a duplicated tab (copied sessionStorage) gets its own database', async ({ page, context }) => {
    await open(page)
    await setSql(page, 'create table dup_t (x int);')
    await run(page)
    await page.waitForTimeout(600)
    const stored = await page.evaluate(() => sessionStorage.getItem('krash:v1:workspace'))
    const dup = await context.newPage()
    await dup.addInitScript((value) => {
      if (!sessionStorage.getItem('krash:v1:workspace') && value) sessionStorage.setItem('krash:v1:workspace', value)
    }, stored)
    await open(dup)
    await expect(dup.getByText('This looks like a duplicated tab')).toBeVisible()
    await expect.poll(() => editorText(dup)).toBe('create table dup_t (x int);')
    await setSql(dup, "select to_regclass('dup_t') is null as absent;")
    await run(dup)
    await expect(results(dup).locator('tbody td').first()).toHaveText('t')
    // The original tab still has its table.
    await setSql(page, "select to_regclass('dup_t') is null as absent;")
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('f')
  })

  test('9: Reset database restores the seed and keeps answers', async ({ page }) => {
    await open(page)
    await setSql(page, 'delete from order_lines; delete from orders;')
    await run(page)
    await page.getByRole('button', { name: 'Reset database', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Reset database' }).click()
    await expect(page.getByText('The database was reset to the original exam dataset')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => editorText(page)).toBe('delete from order_lines; delete from orders;')
    await setSql(page, 'select count(*) from orders;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('240')
  })

  test('10: export, clear answers, import restores names, order and text without running', async ({ page }) => {
    await open(page)
    const texts = ['select 1;', '-- Q2\nselect \'two\';\n', 'select $$ -- ==== krash:end 1 ==== $$;']
    const tabs = ['Question 1', 'Question 2', 'Question 3']
    for (let i = 0; i < 3; i++) {
      await page.getByRole('tab', { name: tabs[i] }).click()
      await setSql(page, texts[i]!)
    }
    // Rename tab 2 with F2.
    await page.getByRole('tab', { name: 'Question 2' }).focus()
    await page.keyboard.press('F2')
    await page.keyboard.press(`${MOD}+A`)
    await page.keyboard.insertText('Joins "and" more')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('tab', { name: 'Joins "and" more' })).toBeVisible()

    await page.getByRole('button', { name: 'Export answers' }).click()
    const dialog = page.getByRole('dialog', { name: 'Export answers' })
    await expect(dialog).toContainText('Downloading is not submitting')
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download .sql' }).click()])
    expect(download.suggestedFilename()).toMatch(/^krash-answers-dbs-practice-\d{8}-\d{4}\.sql$/)
    await expect(dialog).toContainText('This is not a submission')
    const path = await download.path()
    const exported = readFileSync(path!, 'utf8')
    expect(exported.startsWith('-- Krash answers\n-- krash-format: 1\n')).toBe(true)
    await dialog.getByRole('button', { name: 'Close' }).click()

    // Clear answers.
    await page.getByRole('button', { name: 'Workspace' }).click()
    await page.getByRole('button', { name: 'Clear answers…' }).click()
    await page.getByRole('dialog', { name: 'Clear all answers?' }).getByRole('button', { name: 'Clear answers' }).click()
    await expect(page.getByRole('tab', { name: 'Joins "and" more' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Import.
    await page.getByRole('button', { name: 'Import' }).click()
    const imp = page.getByRole('dialog', { name: 'Import answers' })
    await imp.locator('input[type=file]').setInputFiles(path!)
    await expect(imp).toContainText('Found 3 answers')
    await imp.getByRole('button', { name: 'Replace all answers' }).click()
    await page.getByRole('dialog', { name: 'Replace all answers?' }).getByRole('button', { name: 'Replace answers' }).click()

    const names = await page.getByRole('tablist', { name: 'Answers' }).getByRole('tab').allTextContents()
    expect(names).toEqual(['Question 1', 'Joins "and" more', 'Question 3'])
    for (let i = 0; i < 3; i++) {
      await page.getByRole('tab', { name: names[i] }).click()
      await expect.poll(() => editorText(page)).toBe(texts[i])
    }
    // Nothing was executed.
    await expect(results(page)).toContainText('Results appear here')
  })

  test('11: huge results are bounded with an explicit notice', async ({ page }) => {
    await open(page)
    await setSql(page, 'select g, md5(g::text) from generate_series(1, 1000000) g;')
    await run(page)
    await expect(results(page)).toContainText('Showing the first 1,000 of 1,000,000 rows.', { timeout: 60_000 })
    await expect(results(page).locator('tbody tr')).toHaveCount(200)
    await results(page).getByRole('button', { name: /Show 200 more rows/ }).click()
    await expect(results(page).locator('tbody tr')).toHaveCount(400)
  })

  test('12: Stop interrupts a runaway query and keeps committed data', async ({ page }) => {
    await open(page)
    await setSql(page, 'create table before_stop (x int); insert into before_stop values (7);')
    await run(page)
    await setSql(page, 'select count(*) from generate_series(1, 3000000000);')
    await page.getByRole('button', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: 'Stop' }).click()
    await expect(page.getByText('Stopped. The database was reopened')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.db-status')).toHaveText('Ready')
    await setSql(page, 'select x from before_stop;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('7')
  })

  test('13: no completion popups or assistance', async ({ page }) => {
    await open(page)
    await page.locator('.cm-content').click()
    await page.keyboard.type('sel')
    await page.waitForTimeout(500)
    await page.keyboard.press('Control+Space')
    await page.waitForTimeout(300)
    await expect(page.locator('.cm-tooltip, .cm-tooltip-autocomplete')).toHaveCount(0)
    await expect.poll(() => editorText(page)).toBe('sel')
    // No external network requests are made by the app.
  })

  test('COPY FROM STDIN is refused without breaking the engine', async ({ page }) => {
    await open(page)
    await setSql(page, 'copy categories from stdin;')
    await run(page)
    await expect(results(page).getByRole('alert')).toContainText('COPY ... FROM STDIN is not supported')
    await setSql(page, 'select 1 as ok;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('1')
  })

  test('transaction state is shown and survives runs', async ({ page }) => {
    await open(page)
    await setSql(page, 'begin; select 1/0;')
    await run(page)
    await expect(page.locator('.db-status')).toHaveText('Transaction failed · ROLLBACK')
    await expect(results(page).getByRole('alert')).toContainText('run ROLLBACK')
    await setSql(page, 'rollback;')
    await run(page)
    await expect(page.locator('.db-status')).toHaveText('Ready')
  })

  test('the app makes no requests to other origins', async ({ page }) => {
    const foreign: string[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (!['localhost', '127.0.0.1'].includes(u.hostname) && !u.protocol.startsWith('blob') && !u.protocol.startsWith('data')) foreign.push(r.url())
    })
    await open(page)
    await setSql(page, 'select 1;')
    await run(page)
    expect(foreign).toEqual([])
  })
})

test.describe('failure states', () => {
  test('12: missing WASM produces a comprehensible error, answers stay editable', async ({ page, context }) => {
    // context.route also intercepts requests made by the database worker.
    await context.route('**/*.wasm', (route) => route.abort())
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'The database is not available' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Your answers are safe')).toBeVisible()
    await setSql(page, 'select 1;')
    await expect.poll(() => editorText(page)).toBe('select 1;')
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  })

  test('12: blocked session storage is reported prominently', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new DOMException('blocked', 'SecurityError')
        },
      })
    })
    await page.goto('/')
    await expect(page.getByText('Session storage is unavailable')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
    await expect(page.locator('.db-facts')).toContainText('temporary')
  })
})
