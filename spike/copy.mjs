import { PGlite, protocol } from '@electric-sql/pglite'
const db = await PGlite.create()
for (const q of [`create table c(a int); copy c from stdin; select 1`, `copy (select 1) to stdout`, `begin; select 1/0;`, `select 1`, `rollback; select 2`, `listen x; notify x, 'hi'`, `do $$ begin raise notice 'hello %', 42; end $$`, ``, `-- only comment`]) {
  const p = new protocol.Parser(); const out=[]
  const t = Date.now()
  await db.execProtocolRawStream(protocol.serialize.query(q), { onRawData: d => p.parse(d, m => out.push(m.name + (m.status? ':'+m.status : '') + (m.message? ':'+m.message:'') + (m.text?':'+m.text:''))) })
  console.log(JSON.stringify(q), Date.now()-t, out.join(' | '))
}
