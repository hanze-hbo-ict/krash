import { PGlite } from '@electric-sql/pglite'
import { protocol } from '@electric-sql/pglite'; const { serialize } = protocol
const t0 = Date.now()
const db = await PGlite.create()
console.log('boot ms', Date.now() - t0)
console.log((await db.query('select version()')).rows[0])
const r = await db.exec(`create table t(id int primary key, n text); insert into t values (1,null),(2,'a;b'); select * from t where false; select * from t;
 create function f() returns int language plpgsql as $$ begin return 1; end; $$; select f();`)
console.log(JSON.stringify(r.map(x => ({cmd: x.command, rc: x.rowCount, fields: x.fields.map(f=>f.name), rows: x.rows}))))
try { await db.exec(`insert into t values (3,'x'); selec 1; insert into t values (4,'y');`) } catch (e) { console.log('ERR', e.constructor.name, e.message, e.position, e.code, Object.keys(e)) }
console.log((await db.query('select id from t')).rows)
// protocol w/o throwing
const msg = serialize.query(`select 1 as a; select * from nope; select 2`)
const res = await db.execProtocol(msg, { throwOnError: false })
console.log(res.messages.map(m => m.name + (m.message? ':'+m.message:'')))
// statement timeout
await db.exec(`set statement_timeout = '500ms'`)
const t1 = Date.now()
try { await db.exec(`select count(*) from generate_series(1, 300000000)`) ; console.log('no timeout', Date.now()-t1)} catch (e) { console.log('timeout err', e.message, Date.now()-t1) }
try { await db.exec(`select pg_sleep(3)`) ; console.log('sleep no timeout', Date.now()-t1)} catch (e) { console.log('sleep timeout err', e.message, Date.now()-t1) }
await db.exec(`reset statement_timeout`)
// begin w/o commit
await db.exec('begin; insert into t values (9, \'tx\');')
console.log('in tx rows', (await db.query('select count(*) from t')).rows)
await db.exec('rollback')
