#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const ROOTS = ['.github', 'client', 'docs', 'scripts', 'src', 'test']

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith('.json') ? [full] : []
  })
}

const files = [
  ...fs.readdirSync('.').filter((name) => name.endsWith('.json')).map((name) => path.resolve(name)),
  ...ROOTS.flatMap((root) => (fs.existsSync(root) ? walk(root) : [])),
].sort()
let failed = 0
for (const file of files) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    failed += 1
    console.error(`${file}: ${err?.message ?? err}`)
  }
}
console.log(`${files.length - failed}/${files.length} JSON files parse cleanly`)
process.exit(failed > 0 ? 1 : 0)
