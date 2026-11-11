import { PGlite, protocol } from '@electric-sql/pglite'
const db = await PGlite.create()
const q = process.argv[2]
const p = new protocol.Parser(); const out=[]
await db.execProtocolRawStream(protocol.serialize.query(q), { onRawData: d => p.parse(d, m => out.push(m.name + (m.status? ':'+m.status : '') + (m.message? ':'+m.message:'') + (m.text?':'+m.text:''))) })
console.log(JSON.stringify(q), out.join(' | '))
try { console.log('after', (await db.query('select 42 as x')).rows) } catch (e) { console.log('after ERR', e.message) }
