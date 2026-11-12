/**
 * Critical end-to-end acceptance scenarios (see PLAN.md §7).
 * Runs against the production build (vite preview) in Chromium, Firefox and WebKit.
 */
import { expect, test, type Page } from '@playwright/test'

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

/** Run everything in the editor. */
async function run(page: Page) {
  await page.getByRole('button', { name: 'Run all', exact: true }).click()
  await expect(page.locator('.db-status')).not.toHaveText('Running…')
}

const results = (page: Page) => page.locator('#results-body')

test.describe('Krash', () => {
  test('1–2: fresh workspace shows seeded schema; SELECT and DDL work', async ({ page }) => {
    await open(page)
    const tree = page.locator('.schema-tree')
    await expect(tree.getByText('people', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Query', exact: true })).toBeVisible()
    // A new workspace starts with a query on the default table.
    await expect.poll(() => editorText(page)).toBe('SELECT * FROM people;\n')
    await page.getByRole('button', { name: 'Run query', exact: true }).click()
    await expect(page.getByRole('tab', { name: /Result · 3 rows/ })).toBeVisible()

    await setSql(page, 'select count(*) as n from people;')
    await run(page)
    await expect(results(page).locator('table td').first()).toHaveText('3')
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
    const sql = 'select 1;\nselect *\n  fromm people;'
    await setSql(page, sql)
    await run(page)
    const alert = results(page).getByRole('alert')
    await expect(alert).toContainText('syntax error at or near "fromm"')
    await expect(alert).toContainText('Line 3, column 3')
    await expect(alert).toContainText('SQLSTATE 42601')
    await expect.poll(() => editorText(page)).toBe(sql)
    await setSql(page, 'select * from people\nwhere id = 1;')
    await run(page)
    await expect(results(page).getByRole('alert')).toHaveCount(0)
    await expect(results(page).locator('tbody tr')).toHaveCount(1)
  })

  test('5: Run query runs the query at the cursor, Run all everything, a selection wins for both', async ({ page }) => {
    await open(page)
    await setSql(page, 'select 111 as first;\n\nselect 222 as second;\nselect 333 as third;')
    const firstCell = results(page).locator('tbody td').first()
    const ready = () => expect(page.locator('.db-status')).toHaveText('Ready')
    const resultTabs = page.getByRole('tab').filter({ hasNotText: 'Messages' })

    // Cursor at the end of the text: the last query.
    await page.keyboard.press(`${MOD}+Enter`)
    await ready()
    await expect(firstCell).toHaveText('333')
    await expect(page.locator('.run-meta')).toContainText('Query')
    await expect(resultTabs).toHaveCount(1)

    // Cursor in the first query (start of the text).
    await page.keyboard.press(`${MOD}+Home`)
    await page.getByRole('button', { name: 'Run query', exact: true }).click()
    await ready()
    await expect(firstCell).toHaveText('111')

    // Everything.
    await page.keyboard.press(`${MOD}+Shift+Enter`)
    await ready()
    await expect(resultTabs).toHaveCount(3)
    await expect(page.locator('.run-meta')).toContainText('All')

    // A selection (the third line) wins for both buttons.
    await page.locator('.cm-content').click()
    await page.keyboard.press(`${MOD}+End`)
    await page.keyboard.press('Shift+Home')
    await page.getByRole('button', { name: 'Run all', exact: true }).click()
    await ready()
    await expect(firstCell).toHaveText('333')
    await expect(resultTabs).toHaveCount(1)
    await expect(page.locator('.run-meta')).toContainText('Selection')
  })

  test('6–7: the query and database changes survive a reload without re-seeding', async ({ page }) => {
    await open(page)
    await setSql(page, 'create table shared_t (n int);\ninsert into shared_t values (42);')
    await run(page)
    await setSql(page, 'select n from shared_t;')
    await page.waitForTimeout(600) // debounce
    await page.reload()
    await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
    await expect.poll(() => editorText(page)).toBe('select n from shared_t;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('42')
  })

  test('8: a new browser tab gets its own fresh database and the default query', async ({ page, context }) => {
    await open(page)
    await setSql(page, 'create table only_here (x int);')
    await run(page)
    const other = await context.newPage()
    await open(other)
    await expect.poll(() => editorText(other)).toBe('SELECT * FROM people;\n')
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
    await expect.poll(() => editorText(dup)).toBe('create table dup_t (x int);')
    await setSql(dup, "select to_regclass('dup_t') is null as absent;")
    await run(dup)
    await expect(results(dup).locator('tbody td').first()).toHaveText('t')
    // The original tab still has its table.
    await setSql(page, "select to_regclass('dup_t') is null as absent;")
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('f')
  })

  test('9: Reset database restores the base database and keeps the query', async ({ page }) => {
    await open(page)
    await setSql(page, 'delete from people;')
    await run(page)
    await page.getByRole('button', { name: 'Reset database', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Reset database' }).click()
    await expect(page.locator('[role=status]').filter({ hasText: 'The database was reset.' })).toHaveCount(1, { timeout: 60_000 })
    await expect.poll(() => editorText(page)).toBe('delete from people;')
    await setSql(page, 'select count(*) from people;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('3')
  })

  test('10: importing a script replaces the database; Reset and reload keep the imported base', async ({ page }) => {
    await open(page)
    await setSql(page, 'select count(*) from imported_t;')
    const sql = "create table imported_t (id int primary key, note text);\ninsert into imported_t values (1, 'a;b'), (2, $$c$$);\n"
    await page.getByRole('button', { name: 'Import database' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import database' })
    await dialog.locator('textarea').fill(sql)
    await dialog.getByRole('button', { name: 'Replace database' }).click()
    await expect(page.locator('[role=status]').filter({ hasText: 'The database was imported.' })).toHaveCount(1, { timeout: 60_000 })
    const tree = page.locator('.schema-tree')
    await expect(tree.getByText('imported_t', { exact: true })).toBeVisible()
    await expect(tree.getByText('people', { exact: true })).toHaveCount(0)
    // Answers are kept and nothing ran.
    await expect.poll(() => editorText(page)).toBe('select count(*) from imported_t;')
    await expect(results(page)).toHaveText('')

    await setSql(page, 'delete from imported_t;')
    await run(page)
    await page.getByRole('button', { name: 'Reset database', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Reset database' }).click()
    await expect(page.locator('[role=status]').filter({ hasText: 'The database was reset.' })).toHaveCount(1, { timeout: 60_000 })
    await setSql(page, 'select count(*) from imported_t;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('2')

    await page.waitForTimeout(600)
    await page.reload()
    await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
    await expect(page.getByText('different dataset')).toHaveCount(0)
    await expect(tree.getByText('imported_t', { exact: true })).toBeVisible()
  })

  test('10b: a failing import leaves the previous database in use', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import database' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import database' })
    await dialog.locator('textarea').fill('create table ok_t (x int);\nselect 1/0;')
    await dialog.getByRole('button', { name: 'Replace database' }).click()
    await expect(dialog.getByText(/Import failed: .*division by zero.*Your previous database is still in use/)).toBeVisible({ timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('.schema-tree').getByText('people', { exact: true })).toBeVisible()
    await expect(page.locator('.schema-tree').getByText('ok_t', { exact: true })).toHaveCount(0)
  })

  test('import with CREATE DATABASE: one section per database, switching, and reload', async ({ page }) => {
    await open(page)
    const tree = page.locator('.schema-tree')
    await expect(tree.getByText('postgres', { exact: true })).toBeVisible()
    const sql = [
      'create role clerk;',
      'create database shop;',
      'create table products (id int primary key, name text);',
      "insert into products values (1, 'pen');",
      'grant connect on database shop to clerk;',
      'grant select on products to clerk;',
      'create database archive;',
      'create table old_orders (id int);',
    ].join('\n')
    await page.getByRole('button', { name: 'Import database' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import database' })
    await dialog.locator('textarea').fill(sql)
    await dialog.getByRole('button', { name: 'Replace database' }).click()
    await expect(dialog).toBeHidden({ timeout: 60_000 })
    // postgres had a statement (create role), so it is listed; we end in archive.
    await expect(tree.getByText('database · connected')).toBeVisible()
    await expect(tree.locator('details.schema-db > summary')).toContainText('archive')
    await expect(tree.getByText('old_orders', { exact: true })).toBeVisible()
    await expect(tree.getByRole('button', { name: 'Connect to database shop' })).toBeVisible()
    await expect(tree.getByRole('button', { name: 'Connect to database postgres' })).toBeVisible()

    await tree.getByRole('button', { name: 'Connect to database shop' }).click()
    await expect(tree.locator('details.schema-db > summary')).toContainText('shop', { timeout: 60_000 })
    await expect(tree.getByText('products', { exact: true })).toBeVisible()
    await setSql(page, "select current_database(), has_table_privilege('clerk', 'products', 'select');")
    await run(page)
    await expect(results(page).locator('tbody tr').first()).toContainText('shop')

    await page.waitForTimeout(600)
    await page.reload()
    await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
    await expect(tree.locator('details.schema-db > summary')).toContainText('shop')

    // A database created from the editor appears and can be connected to.
    await setSql(page, 'create database scratch;')
    await run(page)
    await expect(tree.getByRole('button', { name: 'Connect to database scratch' })).toBeVisible()
  })

  test('a script that starts with CREATE DATABASE does not show postgres or offer switching', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import database' }).click()
    const dialog = page.getByRole('dialog', { name: 'Import database' })
    await dialog.locator('textarea').fill('create database shop;\ncreate table products (id int);')
    await dialog.getByRole('button', { name: 'Replace database' }).click()
    await expect(dialog).toBeHidden({ timeout: 60_000 })
    const tree = page.locator('.schema-tree')
    await expect(tree.locator('details.schema-db > summary')).toHaveText(/shop\s*database$/)
    await expect(tree.getByText('postgres', { exact: true })).toHaveCount(0)
    await expect(tree.getByRole('button', { name: /Connect to database/ })).toHaveCount(0)
    await expect(tree.getByText('products', { exact: true })).toBeVisible()
  })

  test('switching users: privileges apply, the user survives a reload', async ({ page }) => {
    await open(page)
    const toggle = page.getByRole('button', { name: /Switch user$/ })
    // Only postgres can log in: no user footer.
    await expect(toggle).toHaveCount(0)

    await setSql(page, 'create user alice; create role readers; grant select on people to alice;')
    await run(page)
    await expect(toggle).toHaveAccessibleName('User postgres. Switch user')
    await toggle.click()
    const list = page.getByRole('list', { name: 'Connect as user' })
    await expect(list.getByRole('button')).toHaveCount(2) // readers cannot log in
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden()
    await toggle.click()
    await list.getByRole('button', { name: 'alice' }).click()
    await expect(toggle).toHaveAccessibleName('User alice. Switch user', { timeout: 60_000 })
    await expect(page.locator('.db-status')).toHaveText('Ready')

    await setSql(page, 'select session_user, count(*) from people;')
    await run(page)
    await expect(results(page).locator('tbody tr').first()).toContainText('alice')
    await setSql(page, "insert into people (name) values ('x');")
    await run(page)
    await expect(results(page)).toContainText('permission denied for table people')
    await setSql(page, 'set role postgres;')
    await run(page)
    await expect(results(page)).toContainText('permission denied to set role')

    await page.waitForTimeout(600)
    await page.reload()
    await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
    await expect(toggle).toHaveAccessibleName('User alice. Switch user')

    await toggle.click()
    await list.getByRole('button', { name: /^postgres/ }).click()
    await expect(toggle).toHaveAccessibleName('User postgres. Switch user', { timeout: 60_000 })
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
    await page.getByRole('button', { name: 'Run query', exact: true }).click()
    await page.getByRole('button', { name: 'Stop' }).click()
    await expect(results(page).getByRole('alert')).toContainText('this run and any open transaction were discarded')
    await expect(page.locator('.db-status')).toHaveText('Ready', { timeout: 60_000 })
    await setSql(page, 'select x from before_stop;')
    await run(page)
    await expect(results(page).locator('tbody td').first()).toHaveText('7')
  })

  test('13: no completion popups or assistance', async ({ page }) => {
    await open(page)
    await setSql(page, '')
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
    await setSql(page, 'copy people from stdin;')
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
  test('12: missing WASM produces a comprehensible error, the query stays editable', async ({ page, context }) => {
    // context.route also intercepts requests made by the database worker.
    await context.route('**/*.wasm', (route) => route.abort())
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'The database is not available' })).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Your query is safe')).toBeVisible()
    await setSql(page, 'select 1;')
    await expect.poll(() => editorText(page)).toBe('select 1;')
    await expect(page.getByRole('button', { name: 'Run query', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Run all', exact: true })).toBeDisabled()
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
  })
})
