// Generates public/THIRD_PARTY_NOTICES.txt from the production dependency tree.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const tree = JSON.parse(execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], { encoding: 'utf8' }))
const seen = new Map()
function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    const key = `${name}@${info.version}`
    if (!seen.has(key)) seen.set(key, { name, version: info.version })
    walk(info.dependencies)
  }
}
walk(tree.dependencies)

const out = [
  'Krash — third-party notices',
  '',
  'Krash bundles the following open-source packages. PGlite includes PostgreSQL,',
  'distributed under the PostgreSQL License.',
  '',
]
for (const { name, version } of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = join('node_modules', name)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const licenseFile = existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f)) : undefined
  out.push('='.repeat(78), `${name} ${version}`, `License: ${pkg.license ?? 'see below'}`, pkg.homepage ? `Homepage: ${pkg.homepage}` : '', '')
  if (licenseFile) out.push(readFileSync(join(dir, licenseFile), 'utf8').trim(), '')
}
writeFileSync('public/THIRD_PARTY_NOTICES.txt', out.join('\n') + '\n')
console.log(`Wrote notices for ${seen.size} packages.`)
