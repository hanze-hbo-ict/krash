import { PGlite, protocol } from '@electric-sql/pglite'
const db = await PGlite.create()
const msg = protocol.serialize.query(`select 1 as a, null::text as b; select * from nope;`)
const p = new protocol.Parser()
let out=[]
await db.execProtocolRawStream(msg, { onRawData: (d) => p.parse(d, m => out.push(m.name)) })
console.log(out)
const t=Date.now(); let rows=0, chunks=0, maxChunk=0
const p2 = new protocol.Parser()
await db.execProtocolRawStream(protocol.serialize.query(`select g, md5(g::text) from generate_series(1,3000000) g`), { onRawData: (d) => { chunks++; maxChunk=Math.max(maxChunk,d.length); p2.parse(d, m => { if (m.name==='dataRow') rows++ }) } })
console.log({rows, chunks, maxChunk, ms: Date.now()-t, rss: process.memoryUsage().rss/1e6})
