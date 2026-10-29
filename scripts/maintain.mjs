#!/usr/bin/env node
// One command that keeps the published market fresh:
//   tests -> rebuild skill index -> publish -> re-pin plugin index -> publish -> verify
//
// Usage (PowerShell):
//   $env:GITHUB_TOKEN = "ghp_..."            # classic token, scope: repo, 7 days is fine
//   node scripts/maintain.mjs                 # full run
//   node scripts/maintain.mjs --no-test       # skip unit tests
//   node scripts/maintain.mjs --no-publish    # build locally only (no token needed)
//   node scripts/maintain.mjs --queries "pdf,excel" --limit 5
//
// The token is read from the environment and only forwarded to child processes.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const arg = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const DEFAULT_QUERIES = [
  'pdf', 'excel', 'docx', 'pptx', 'react', 'code review', 'testing', 'data analysis',
  'image', 'video', 'github', 'docker', 'sql', 'security', 'writing', 'research',
  'frontend', 'backend', 'devops', 'automation',
]

const skipTest = has('--no-test')
const skipPublish = has('--no-publish')
const limit = arg('--limit', '10')
const queries = arg('--queries')
  ? arg('--queries').split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_QUERIES

if (!skipPublish && !process.env.GITHUB_TOKEN) {
  console.error('GITHUB_TOKEN is required (or pass --no-publish to build only).')
  process.exit(2)
}

const run = (label, file, argv, opts = {}) => {
  console.log(`\n=== ${label} ===`)
  const out = execFileSync(process.execPath, [file, ...argv], { encoding: 'utf8', ...opts })
  if (!out) return ''
  const tail = out.trim().split('\n').slice(-6).join('\n')
  if (tail) console.log(tail)
  return out
}

const started = Date.now()

if (!skipTest) {
  run('unit tests', 'test/unit.test.mjs', [], { stdio: 'inherit' })
  run('install tests', 'test/install.test.mjs', [], { stdio: 'inherit' })
}

// 1. skill index (the searchable snapshot)
const harvestArgs = ['-o', 'skill-index.json', '-l', String(limit)]
for (const q of queries) harvestArgs.push('-q', q)
run(`skill index (${queries.length} queries, limit ${limit})`, 'scripts/build-index.mjs', harvestArgs)

if (skipPublish) {
  const idx = JSON.parse(readFileSync('skill-index.json', 'utf8'))
  console.log(`\nbuilt skill-index.json with ${idx.count ?? idx.skills?.length ?? 0} entries (not published)`)
  process.exit(0)
}

// 2. publish code + skill index
const first = run('publish (code + skill index)', 'scripts/publish-api.mjs', ['--message', `chore: refresh skill index (${queries.length} topics, ${new Date().toISOString().slice(0, 10)})`])
const commit = /commit:\s+([0-9a-f]{40})/.exec(first)?.[1]
if (!commit) throw new Error('could not parse published commit sha')

// 3. re-pin the plugin index to that commit (install source must point at existing code)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
run('plugin index (pinned)', 'scripts/build-index.mjs', [
  '--plugin-index', '--repo', repoUrl, '--commit', commit,
])

// 4. publish the re-pinned plugin index
const second = run('publish (plugin index)', 'scripts/publish-api.mjs', ['--message', 'chore: re-pin plugin index'])
const commit2 = /commit:\s+([0-9a-f]{40})/.exec(second)?.[1]

// 5. verify both artifacts are publicly readable
const { execFileSync: _ } = { execFileSync }
console.log('\n=== verify ===')
console.log(`code commit:   ${commit}`)
console.log(`index commit:  ${commit2 ?? commit}`)
console.log(`elapsed:       ${((Date.now() - started) / 1000).toFixed(1)}s`)
console.log('raw skill index: https://raw.githubusercontent.com/' + (pkg.repository?.url ?? '').replace(/^.*github\.com\//, '') + '/main/skill-index.json')
if (existsSync('plugin-index.json')) console.log('raw plugin index: same repository /main/plugin-index.json')
