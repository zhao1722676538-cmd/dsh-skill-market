#!/usr/bin/env node
/**
 * Stand-alone command line for hosts that are not DeepSeek Harness.
 *
 * The DSH plugin shell (panel + model tools) is DSH-specific, but everything
 * below it is portable: search the four marketplaces, then write a SKILL.md
 * tree into whatever directory the host scans. Any agent that can run a shell
 * command — Codex CLI, Claude Code, Cursor, a plain terminal — can use this.
 *
 *   node src/cli.js search pdf
 *   node src/cli.js install anthropics/skills/pdf --to claude
 *   node src/cli.js list
 *   node src/cli.js uninstall pdf
 *
 * @module dsh-skill-market/cli
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { SOURCES, searchAll } from './sources/index.js'
import { parseGitHubUrl, repoOf } from './sources/util.js'
import { installSkill, uninstallSkill, listInstalled } from './install/installer.js'
import { createHttp } from './net.js'
import { parseIndexDocument, searchIndex } from './index-store.js'
import { resolveInstallRoot } from './registry.js'

const SOURCE_IDS = Object.keys(SOURCES)
const VERSION = '0.1.0'

const home = () => os.homedir()
const xdg = () => envOr('XDG_CONFIG_HOME', path.join(home(), '.config'))

function envOr (name, fallback) {
  const value = process.env[name]
  return value && value.trim() !== '' ? value.trim() : fallback
}

const skillsIn = (dir) => path.join(dir, 'skills')

/**
 * Named skill directories of known hosts. Paths were verified against
 * vercel-labs/skills v1.3.9 (`src/agents.ts`), the Claude Code docs and DSH's own
 * skill discovery. `--to <path>` works for any host that is not listed here.
 */
const TARGETS = {
  dsh: () => skillsIn(envOr('DSH_HOME', path.join(home(), '.dsh'))),
  agents: () => skillsIn(envOr('AGENTS_HOME', path.join(home(), '.agents'))),
  claude: () => skillsIn(envOr('CLAUDE_CONFIG_DIR', path.join(home(), '.claude'))),
  'claude-code': () => TARGETS.claude(),
  codex: () => skillsIn(envOr('CODEX_HOME', path.join(home(), '.codex'))),
  cursor: () => skillsIn(path.join(home(), '.cursor')),
  gemini: () => skillsIn(path.join(home(), '.gemini')),
  copilot: () => skillsIn(path.join(home(), '.copilot')),
  opencode: () => skillsIn(path.join(xdg(), 'opencode')),
  amp: () => skillsIn(path.join(xdg(), 'agents')),
  goose: () => skillsIn(path.join(xdg(), 'goose')),
  windsurf: () => skillsIn(path.join(home(), '.codeium', 'windsurf')),
  cline: () => skillsIn(path.join(home(), '.cline')),
  roo: () => skillsIn(path.join(home(), '.roo')),
  continue: () => skillsIn(path.join(home(), '.continue')),
  qwen: () => skillsIn(path.join(home(), '.qwen')),
}

const HELP = `dsh-skill-market ${VERSION} — search and install agent skills from the command line

Usage
  node src/cli.js <command> [options]

Commands
  search <query>              Search skillsmp, skillstore, skills.sh and GitHub
  install <coordinate>        Install one skill into a skills directory
  list                        Show installed skills
  uninstall <name>            Remove an installed skill
  sources                     List the enabled marketplaces
  help                        This text

search
  --source a,b                Only these sources (${SOURCE_IDS.join(', ')})
  --limit N                   Max entries per source (default 10, max 50)
  --index <path|url[,..]>     Filter a static index locally instead of going live
  --offline                   With --index: never fall back to a live search
  --json                      Machine-readable output

install
  <coordinate>                owner/repo, owner/repo/path, or a GitHub URL
  --name <name>               Install as this directory name (default from the skill)
  --path <dir>                Directory inside the repository holding SKILL.md
  --ref <commit|branch|tag>   Install a specific revision
  --to <target|path>          ${Object.keys(TARGETS).join(' | ')} or any directory
                              (default: auto-detected DSH skills dir)
  --overwrite                 Replace a directory this tool does not manage
  --dry-run                   Resolve and report without writing anything
  --json                      Machine-readable output

list / uninstall
  --to <target|path>          Same as install (default: auto-detected DSH skills dir)
  --force                     Uninstall even if files changed after install
  --json                      Machine-readable output

Environment
  DSH_HOME, AGENTS_HOME       Change the default skill roots
  GITHUB_TOKEN, SKILLSMP_API_KEY
                              Higher rate limits for the GitHub / skillsmp sources
`

/**
 * @param {string[]} argv
 * @returns {{command: string, positional: string[], flags: Record<string, string|boolean|string[]>}}
 */
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  let command = ''
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (!token.startsWith('--')) {
      if (command === '') command = token
      else positional.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase()
    let value = eq === -1 ? undefined : token.slice(eq + 1)
    if (value === undefined) {
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        value = next
        index += 1
      }
    }
    if (name === 'index') {
      /** @type {string[]} */
      const previous = Array.isArray(flags.index) ? flags.index : []
      const parts = String(value ?? '').split(',').map((part) => part.trim()).filter(Boolean)
      flags.index = [...previous, ...parts]
      continue
    }
    flags[name] = value === undefined ? true : value
  }
  return { command: command.toLowerCase(), positional, flags }
}

/**
 * Resolve `--to` into an absolute skills directory.
 * @param {string|undefined} value
 * @param {{exists?: (p: string) => boolean}} [deps]
 * @returns {string}
 */
export function resolveTarget(value, deps = {}) {
  const exists = deps.exists ?? ((p) => fs.existsSync(p))
  if (typeof value === 'string' && value.trim() !== '') {
    const key = value.trim().toLowerCase()
    if (TARGETS[key]) return path.resolve(TARGETS[key]())
    return path.resolve(value.trim())
  }
  if (process.env.DSH_HOME?.trim()) {
    const dsh = path.join(process.env.DSH_HOME.trim(), 'skills')
    if (exists(dsh) || exists(path.dirname(dsh))) return path.resolve(dsh)
  }
  const home = os.homedir()
  for (const candidate of [path.join(home, '.dsh', 'skills'), path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills')]) {
    if (exists(candidate)) return path.resolve(candidate)
  }
  return path.resolve(path.join(home, '.dsh', 'skills'))
}

/**
 * Turn an install coordinate (`owner/repo`, `owner/repo/dir`, GitHub URL) into
 * the entry the installer understands.
 * @param {string} coordinate
 * @param {{name?: string, path?: string, ref?: string}} flags
 * @returns {{name: string, repo: string, path?: string, ref?: string, source: string, id: string}}
 */
export function coordinateEntry(coordinate, flags = {}) {
  const raw = String(coordinate ?? '').trim()
  if (raw === '') throw new Error('install needs a coordinate: owner/repo, owner/repo/path, or a GitHub URL')
  if (raw.includes(':') || raw.startsWith('http') || raw.startsWith('git@')) {
    const parsed = parseGitHubUrl(raw)
    if (!parsed) throw new Error(`not a GitHub coordinate: ${raw}`)
    const name = flags.name?.trim() || suggestName(parsed.path, parsed.repo)
    return { name, repo: parsed.repo, path: flags.path?.trim() || parsed.path, ref: flags.ref?.trim() || parsed.ref, source: 'github', id: `github:${parsed.repo}` }
  }
  const segments = raw.split('/').map((part) => part.trim()).filter(Boolean)
  if (segments.length < 2) throw new Error(`expected owner/repo[/path], got: ${raw}`)
  const repo = repoOf(`${segments[0]}/${segments[1]}`)
  if (!repo) throw new Error(`invalid repository: ${segments[0]}/${segments[1]}`)
  const rest = segments.slice(2).join('/')
  const name = flags.name?.trim() || suggestName(rest, repo)
  return { name, repo, path: flags.path?.trim() || rest || undefined, ref: flags.ref?.trim() || undefined, source: 'github', id: `github:${repo}` }
}

/**
 * @param {string|undefined} dirPath
 * @param {string} repo
 * @returns {string}
 */
function suggestName(dirPath, repo) {
  const leaf = String(dirPath ?? '').split('/').filter(Boolean).pop()
  if (leaf && leaf.toLowerCase() !== 'skills' && /^[a-z0-9][a-z0-9._-]*$/i.test(leaf)) return leaf.toLowerCase()
  const tail = repo.split('/')[1] ?? 'skill'
  return tail.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'
}

/**
 * Read one index location: a local file, a file:// URL, or an http(s) URL.
 * @param {string} location
 * @param {{http: any}} deps
 * @returns {Promise<{entries: any[], meta: any}>}
 */
export async function loadIndex(location, deps) {
  const text = /^https?:\/\//i.test(location)
    ? await deps.http(location).then((response) => response.text())
    : await fs.promises.readFile(location.replace(/^file:\/\//i, ''), 'utf8')
  return parseIndexDocument(text, location)
}

/**
 * @param {any[]} entries
 * @param {{limit?: number, max?: number}} [options]
 * @returns {string}
 */
export function formatTable(entries, options = {}) {
  if (entries.length === 0) return 'no results'
  const max = options.max ?? entries.length
  const rows = entries.slice(0, max).map((entry, index) => {
    const facts = [
      entry.source,
      entry.installs ? `${entry.installs} installs` : '',
      entry.stars ? `${entry.stars}★` : '',
      entry.risk ?? '',
    ]
      .filter(Boolean)
      .join(' · ')
    const where = entry.repo ? `${entry.repo}${entry.path ? `/${entry.path}` : ''}` : entry.url ?? ''
    return `${String(index + 1).padStart(2)}. ${entry.name}  [${facts}]${where ? `\n    ${where}` : ''}\n    ${String(entry.description ?? '').slice(0, 160)}`
  })
  const lines = [rows.join('\n')]
  if (entries.length > max) lines.push(`… ${entries.length - max} more`)
  return lines.join('\n')
}

/** @param {unknown} value */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** @param {string} message */
function fail(message, code = 1) {
  process.stderr.write(`error: ${message}\n`)
  process.exitCode = code
}

/**
 * @param {{command: string, positional: string[], flags: Record<string, any>}} args
 * @param {{cwd?: string}} [context]
 * @returns {Promise<number>} exit code
 */
export async function run(args, context = {}) {
  const { command, positional, flags } = args
  const json = flags.json === true
  const log = (message) => {
    if (!json) process.stderr.write(`${message}\n`)
  }

  if (command === '' || command === 'help' || flags.help === true) {
    process.stdout.write(HELP)
    return 0
  }
  if (command === 'version' || flags.version === true) {
    process.stdout.write(`dsh-skill-market ${VERSION}\n`)
    return 0
  }
  if (command === 'sources') {
    const rows = Object.entries(SOURCES).map(([id, source]) => ({
      id,
      site: source.home ?? '',
      label: typeof source.label === 'string' ? source.label : '',
    }))
    if (json) printJson(rows)
    else process.stdout.write(rows.map((row) => `${row.id.padEnd(10)} ${row.site}${row.label ? `  (${row.label})` : ''}`).join('\n') + '\n')
    return 0
  }

  const deps = {
    http: createHttp({ timeoutMs: 20000 }),
    tokens: {
      skillsmp: process.env.SKILLSMP_API_KEY?.trim() ?? '',
      github: process.env.GITHUB_TOKEN?.trim() ?? '',
    },
    log: () => {},
  }

  if (command === 'search') {
    const query = positional.join(' ').trim()
    if (query === '') return fail('search needs a query, e.g. `search pdf`', 2) ?? 2
    const sources = flags.source
      ? String(flags.source).split(',').map((part) => part.trim().toLowerCase()).filter((id) => SOURCE_IDS.includes(id))
      : undefined
    const limit = Math.max(1, Math.min(50, Number(flags.limit) || 10))
    const indexLocations = Array.isArray(flags.index) ? flags.index : []

    let items = []
    let mode = 'live'
    let reports = []
    let indexed
    if (indexLocations.length > 0) {
      const entries = []
      for (const location of indexLocations) {
        try {
          const document = await loadIndex(location, deps)
          entries.push(...document.entries)
        } catch (err) {
          log(`index ${location}: ${err?.message ?? String(err)}`)
        }
      }
      indexed = entries.length
      items = searchIndex(entries, { query, sources, limit })
      mode = 'index'
      if (items.length === 0 && flags.offline !== true) {
        const live = await searchAll({ query, sources, limit }, deps)
        items = live.items
        reports = live.reports
        mode = entries.length > 0 ? 'index+live' : 'live'
      }
    } else {
      const live = await searchAll({ query, sources, limit }, deps)
      items = live.items
      reports = live.reports
    }

    if (json) {
      printJson({ query, mode, indexed, items, reports })
    } else {
      const failed = reports.filter((report) => !report.ok)
      process.stdout.write(`${items.length} result(s) · ${mode}${indexed !== undefined ? ` · index ${indexed} entries` : ''}\n\n`)
      process.stdout.write(`${formatTable(items)}\n`)
      if (failed.length > 0) log(`source errors: ${failed.map((report) => `${report.source}: ${report.error}`).join(' | ')}`)
    }
    return 0
  }

  if (command === 'install') {
    const coordinate = positional.join(' ').trim()
    let entry
    try {
      const parsed = coordinateEntry(coordinate, { name: flags.name, path: flags.path, ref: flags.ref })
      entry = parsed
    } catch (err) {
      return fail(err?.message ?? String(err), 2) ?? 2
    }
    const installRoot = resolveTarget(flags.to)
    if (flags['dry-run'] === true) {
      const payload = { dryRun: true, name: entry.name, repo: entry.repo, path: entry.path, ref: entry.ref, target: installRoot }
      if (json) printJson(payload)
      else process.stdout.write(`would install ${entry.name} from ${entry.repo}${entry.path ? `/${entry.path}` : ''} → ${installRoot}\n`)
      return 0
    }
    try {
      const result = await installSkill(entry, { installRoot, deps, overwrite: flags.overwrite === true })
      if (json) {
        printJson({ ok: true, name: result.name, dir: result.dir, files: result.files, repo: result.repo, commit: result.commit, updated: result.updated, warnings: result.warnings })
      } else {
        process.stdout.write(`installed ${result.name}${result.repo ? ` from ${result.repo}@${String(result.commit ?? '').slice(0, 12)}` : ''} (${result.files} files) → ${result.dir}\n`)
        for (const warning of result.warnings ?? []) log(`warning: ${warning}`)
        log(`the host must rescan its skills directory for "${result.name}" to appear (DSH does it automatically)`)
      }
      return 0
    } catch (err) {
      return fail(err?.message ?? String(err), 1) ?? 1
    }
  }

  if (command === 'list') {
    const installRoot = resolveTarget(flags.to)
    const installed = await listInstalled({ installRoot })
    let unmanaged = []
    try {
      const names = await fs.promises.readdir(installRoot, { withFileTypes: true })
      const managed = new Set(installed.map((item) => item.name))
      for (const dirent of names) {
        if (!dirent.isDirectory() || dirent.name.startsWith('.') || managed.has(dirent.name)) continue
        if (fs.existsSync(path.join(installRoot, dirent.name, 'SKILL.md')) || fs.existsSync(path.join(installRoot, `${dirent.name}.md`))) {
          unmanaged.push(dirent.name)
        }
      }
    } catch {
      // directory does not exist yet — nothing installed
    }
    if (json) {
      printJson({ root: installRoot, installed, unmanaged })
    } else {
      process.stdout.write(`${installed.length} managed skill(s) in ${installRoot}\n`)
      for (const item of installed) {
        const where = item.repo ? `${item.repo}${item.commit ? `@${String(item.commit).slice(0, 12)}` : ''}` : (item.source ?? 'unknown')
        process.stdout.write(`  ${item.name.padEnd(24)} ${where}${item.present === false ? '  (missing on disk)' : ''}\n`)
      }
      if (unmanaged.length > 0) process.stdout.write(`unmanaged on disk: ${unmanaged.join(', ')}\n`)
    }
    return 0
  }

  if (command === 'uninstall') {
    const name = positional.join(' ').trim()
    if (name === '') return fail('uninstall needs a skill name', 2) ?? 2
    const installRoot = resolveTarget(flags.to)
    const result = await uninstallSkill(name, { installRoot, force: flags.force === true })
    if (json) printJson(result)
    else if (result.ok) process.stdout.write(`uninstalled ${result.name} (${(result.removed ?? []).join(', ')})\n`)
    else {
      process.stdout.write(`did not uninstall ${result.name}: ${result.reason ?? 'unknown reason'}\n`)
      for (const conflict of result.conflicts ?? []) process.stdout.write(`  modified: ${conflict}\n`)
    }
    return result.ok ? 0 : 1
  }

  process.stderr.write(`unknown command: ${command}\n\n${HELP}`)
  return 2
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()
})()

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  run(args).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      fail(err?.stack ?? String(err), 1)
    },
  )
}

export default { parseArgs, resolveTarget, coordinateEntry, formatTable, loadIndex, run }
