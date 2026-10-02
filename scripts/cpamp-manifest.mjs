// Usage: node scripts/cpamp-manifest.mjs /path/to/pinned/CPA-Manager-Plus
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const upstream = path.resolve(process.argv[2] || ''), root = path.resolve('console/src/vendor/cpamp')
if (!process.argv[2] || !fs.existsSync(path.join(upstream, 'apps/web/src'))) throw new Error('Pass the pinned CPA-Manager-Plus checkout')
const hash = file => createHash('sha256').update(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(file); continue }
    const relative = path.relative(root, file).split(path.sep).join('/')
    const source = path.join(upstream, 'apps/web/src', relative)
    if (!fs.existsSync(source)) continue
    const original = hash(source), local = hash(file)
    files.push({ path: relative, upstream: original, local, adapted: original !== local })
  }
}
walk(root)
fs.writeFileSync(path.join(root, 'SOURCE-MANIFEST.json'), JSON.stringify({ repository: 'https://github.com/seakee/CPA-Manager-Plus', commit: '05ebb7f275dbe575211cb886436d4b99936c1cd9', normalization: 'UTF-8 text with LF line endings', files }, null, 2) + '\n')
console.log(`${files.length} source files; ${files.filter(f => !f.adapted).length} unchanged`)
