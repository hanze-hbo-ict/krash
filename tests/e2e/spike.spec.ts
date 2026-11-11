/**
 * Phase A go/no-go: PGlite in a worker, IndexedDB persistence per session.
 * Runs against the dev server only (the spike page is not part of the build).
 */
import { expect, test } from '@playwright/test'

test.skip(!process.env.KRASH_E2E_DEV, 'spike runs only against the dev server')

type Outcome = { error: { message: string; position?: string } | null; results: { columns: { name: string }[] | null; rows: (string | null)[][] }[] }

test('PGlite boots, seeds, executes and persists across reload in the same tab', async ({ page, context }) => {
  await page.goto('/spike/index.html')
  const info = await page.evaluate(() => window.spike.ready)
  expect(info).toMatchObject({ seeded: true, datasetId: 'webshop-v1', persistent: true })

  const run = (sql: string) => page.evaluate((s) => window.spike.run(s), sql) as Promise<Outcome>
  let out = await run(`create table t (id int primary key, v text); insert into t values (1, null), (2, 'x'); select * from t order by id; select c.first_name, count(o.id) from customers c join orders o on o.customer_id = c.id group by 1 order by 2 desc, 1 limit 1;`)
  expect(out.error).toBeNull()
  expect(out.results[2]!.rows).toEqual([['1', null], ['2', 'x']])
  out = await run('selec 1')
  expect(out.error?.message).toContain('syntax error')

  await page.reload()
  const info2 = await page.evaluate(() => window.spike.ready)
  expect(info2).toMatchObject({ seeded: false, datasetId: 'webshop-v1' })
  out = await run('select count(*) from t')
  expect(out.results[0]!.rows).toEqual([['2']])

  // Another tab in the same context = new session => fresh, isolated database.
  const other = await context.newPage()
  await other.goto('/spike/index.html')
  const info3 = await other.evaluate(() => window.spike.ready)
  expect(info3).toMatchObject({ seeded: true })
  const out3 = (await other.evaluate(() => window.spike.run('select to_regclass(\'t\') is null as missing'))) as Outcome
  expect(out3.results[0]!.rows).toEqual([['t']])

  const names = await page.evaluate(async () => (await indexedDB.databases?.())?.map((d) => d.name) ?? null)
  console.log('IndexedDB names:', names)
})

test('the worker can be terminated mid-query and the database reopened', async ({ page }) => {
  await page.goto('/spike/index.html')
  await page.evaluate(() => window.spike.ready)
  await page.evaluate(() => window.spike.run("create table keep (v text); insert into keep values ('committed')"))
  const started = await page.evaluate(() => {
    const p = window.spike.run('select count(*) from generate_series(1, 2000000000)').then(() => 'finished', (e: { failure?: { kind: string } }) => 'rejected:' + e?.failure?.kind)
    return new Promise<string>((resolve) => setTimeout(() => { window.spike.client.stop(); p.then(resolve) }, 1500))
  })
  expect(started).toBe('rejected:cancelled')
  const info = await page.evaluate(() => window.spike.client.request({ type: 'init', dbName: window.spike.dbName, dataset: { id: 'webshop-v1', sql: '', expectedTables: [] } }))
  expect(info).toMatchObject({ seeded: false })
  const out = (await page.evaluate(() => window.spike.run('select v from keep'))) as Outcome
  expect(out.results[0]!.rows).toEqual([['committed']])
})
