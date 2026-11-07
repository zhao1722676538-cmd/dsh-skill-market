#!/usr/bin/env node
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const index = JSON.parse(fs.readFileSync('plugin-index.json', 'utf8'))
const plugin = index?.plugins?.find?.((item) => item.name === pkg.name)
const problems = []

if (!plugin) problems.push(`plugin-index.json does not list ${pkg.name}`)
const version = plugin?.versions?.find?.((item) => item.version === pkg.version)
if (!version) problems.push(`plugin-index.json does not contain version ${pkg.version}`)
if (!/^[0-9a-f]{40}$/.test(String(version?.source?.commit ?? ''))) {
  problems.push('plugin-index.json must pin a 40-hex commit')
}
if (!/^https:\/\/github\.com\//.test(String(version?.source?.url ?? ''))) {
  problems.push('plugin-index.json must use an HTTPS GitHub repository URL')
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`- ${problem}`)
  console.error('Run: node scripts/build-index.mjs --plugin-index')
  process.exit(1)
}
console.log(`plugin-index.json is consistent with ${pkg.name}@${pkg.version}`)
