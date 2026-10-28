#!/usr/bin/env node
/**
 * Build a static skill index from live marketplace searches.
 *
 *   node scripts/build-index.mjs --query pdf --query excel \
 *     --sources skillsmp,skillssh,github --limit 10 \
 *     --out ~/.dsh/cache/skill-market/skill-index.json
 *
 * Then point the plugin at the file (or a URL serving it):
 *
 *   - id: skill-market
 *     config:
 *       indexes: ['C:/Users/you/.dsh/cache/skill-market/skill-index.json']
 *
 * After that, searches are a local filter: no marketplace API, no GitHub token,
 * no anonymous rate limit.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { buildIndex } from '../src/index-build.js'
import { buildPluginIndex, serializePluginIndex } from '../src/plugin-index.js'
import { serializeIndex } from '../src/index-store.js'
import { createHttp } from '../src/net.js'
import { SOURCE_IDS } from '../src/index.js'

function usage() {
  return `Usage: node scripts/build-index.mjs --query <term> [--query <term> ...] [options]
       node scripts/build-index.mjs --plugin-index [--repo <url> --commit <sha>] [options]

Skill index (default):
  -q, --query <term>     Search term to harvest (repeatable, at least one)
  -s, --sources <list>   Comma list of sources (${SOURCE_IDS.join(', ')}); default all
  -l, --limit <n>        Entries per query (default 10, capped at 50)
  -o, --out <path>       Output file (default ~/.dsh/cache/skill-market/skill-index.json)
      --timeout <ms>     HTTP timeout per request (default 15000)

DSH plugin-market index (format 1):
      --plugin-index     Emit a plugin index for the package in the current directory
      --repo <url>       Repository URL (default: git remote, then package.json repository)
      --commit <sha>     Pinned 40-hex commit (default: git HEAD)
      --path <dir>       Package directory inside the repo (monorepo support)
      --npm              Declare the npm registry as the install source instead of git
      --title <text>     Market title (default: package displayName, then name)
      --keywords <list>  Comma list of keywords (default: package.json keywords)
      --author <text>    Author name
      --homepage <url>   Homepage URL
      --icon <url>       https URL or data: URL (<=32 KiB decoded)
  -o, --out <path>       Output file (default ./plugin-index.json for plugin mode)

  -h, --help             Show this help

Examples:
  node scripts/build-index.mjs -q pdf -q excel -q slides
  node scripts/build-index.mjs -q "code review" -s github,skillssh -l 20 -o ./index.json
  node scripts/build-index.mjs --plugin-index --repo https://github.com/me/dsh-skill-market`
}

const argv = process.argv.slice(2)
/** @type {{queries: string[], sources: string[], limit?: number, out?: string, timeout?: number, help: boolean, plugin?: {repo?: string, commit?: string, path?: string, sourceType?: 'git' | 'npm', title?: string, keywords?: string[], author?: string, homepage?: string, icon?: string}}} */
const options = { queries: [], sources: [], help: false }

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  const next = () => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('-')) throw new Error(`${arg} needs a value`)
    index += 1
    return value
  }
  switch (arg) {
    case '-q':
    case '--query':
      options.queries.push(next())
      break
    case '-s':
    case '--sources':
      options.sources.push(...next().split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))
      break
    case '-l':
    case '--limit':
      options.limit = Number(next())
      break
    case '-o':
    case '--out':
      options.out = next()
      break
    case '--timeout':
      options.timeout = Number(next())
      break
    case '--plugin-index':
      options.plugin = { ...(options.plugin ?? {}) }
      break
    case '--repo':
      options.plugin = { ...(options.plugin ?? {}), repo: next() }
      break
    case '--commit':
      options.plugin = { ...(options.plugin ?? {}), commit: next() }
      break
    case '--path':
      options.plugin = { ...(options.plugin ?? {}), path: next() }
      break
    case '--npm':
      options.plugin = { ...(options.plugin ?? {}), sourceType: 'npm' }
      break
    case '--title':
      options.plugin = { ...(options.plugin ?? {}), title: next() }
      break
    case '--keywords':
      options.plugin = {
        ...(options.plugin ?? {}),
        keywords: next().split(',').map((item) => item.trim()).filter(Boolean),
      }
      break
    case '--author':
      options.plugin = { ...(options.plugin ?? {}), author: next() }
      break
    case '--homepage':
      options.plugin = { ...(options.plugin ?? {}), homepage: next() }
      break
    case '--icon':
      options.plugin = { ...(options.plugin ?? {}), icon: next() }
      break
    case '-h':
    case '--help':
      options.help = true
      break
    default:
      if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
      options.queries.push(arg)
  }
}

if (options.help) {
  process.stdout.write(`${usage()}\n`)
  process.exit(0)
}

if (options.plugin !== undefined) {
  const outPath = options.out ? path.resolve(options.out) : path.resolve('plugin-index.json')
  const { document, warnings } = buildPluginIndex({ ...options.plugin })
  const text = serializePluginIndex(document)
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, text)
  const plugin = /** @type {{name: string, versions: {version: string, source: Record<string, unknown>}[]}} */ (
    /** @type {unknown} */ (document.plugins[0])
  )
  const version = plugin.versions[0]
  for (const warning of warnings) process.stderr.write(`! ${warning}\n`)
  process.stdout.write(
    `${JSON.stringify(
      {
        out: outPath,
        bytes: Buffer.byteLength(text),
        format: document.format,
        plugin: plugin.name,
        version: version.version,
        source: version.source.type === 'git' ? `git+${String(version.source.url)}#${String(version.source.commit)}` : 'npm',
        next: [
          'host it as a file or URL, then add it to the plugin market indexes:',
          '  - id: plugin-market',
          "    name: '@deepseek-ai/dsh-plugin-market'",
          '    config:',
          `      indexes: ['${outPath.replaceAll('\\', '/')}']`,
        ],
      },
      undefined,
      2,
    )}\n`,
  )
  process.exit(0)
}

if (options.queries.length === 0) {
  process.stderr.write(`${usage()}\n`)
  process.exit(2)
}

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
const outPath = options.out ? path.resolve(options.out) : path.join(home, 'cache', 'skill-market', 'skill-index.json')
const timeoutMs = Number.isFinite(options.timeout) && options.timeout > 0 ? options.timeout : 15000

const started = Date.now()
const index = await buildIndex({
  queries: options.queries,
  sources: options.sources,
  perSourceLimit: options.limit,
  deps: {
    http: createHttp({ timeoutMs }),
    tokens: {},
    log: (message) => process.stderr.write(`· ${message}\n`),
  },
  log: (message) => process.stderr.write(`· ${message}\n`),
  onQuery: ({ query, count, ms }) => process.stderr.write(`  ${query}: ${count} entries in ${ms}ms\n`),
})

const text = serializeIndex(index)
await fs.mkdir(path.dirname(outPath), { recursive: true })
await fs.writeFile(outPath, text)

const failed = index.reports.filter((report) => !report.ok)
process.stdout.write(
  `${JSON.stringify(
    {
      out: outPath,
      count: index.skills.length,
      bytes: Buffer.byteLength(text),
      queries: options.queries,
      sources: index.sources,
      failed: failed.map((report) => ({ query: report.query, error: report.error })),
      ms: Date.now() - started,
    },
    undefined,
    2,
  )}\n`,
)
