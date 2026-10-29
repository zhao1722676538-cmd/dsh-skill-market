import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { dedupe, rank } from '../src/sources/index.js'
import { createIndexStore, parseIndexDocument, searchIndex, serializeIndex } from '../src/index-store.js'
import { buildIndex } from '../src/index-build.js'
import { search as githubSearch } from '../src/sources/github.js'
import { parseGitHubUrl, repoOf, slugify, clamp, pageWindow } from '../src/sources/util.js'
import { locateSkillDir, normalizeRepo } from '../src/install/github.js'
import { parseFrontmatter } from '../src/install/installer.js'
import { readRegistry, resolveInstallRoot, validateSkillName, writeRegistry } from '../src/registry.js'
import {
  buildPluginIndex,
  looksLikeSemverRange,
  normalizeRemoteUrl,
  pluginIndexDocument,
  serializePluginIndex,
} from '../src/plugin-index.js'
import { coordinateEntry, formatTable, parseArgs, resolveTarget } from '../src/cli.js'

test('parseGitHubUrl accepts the URL shapes marketplaces hand out', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/anthropics/skills'), { repo: 'anthropics/skills' })
  assert.deepEqual(parseGitHubUrl('https://github.com/anthropics/skills/tree/main/skills/pdf'), {
    repo: 'anthropics/skills',
    ref: 'main',
    path: 'skills/pdf'
  })
  assert.equal(parseGitHubUrl('anthropics/skills'), null, 'bare coordinates are not GitHub URLs')
  assert.equal(parseGitHubUrl('https://example.com/nope'), null)
  assert.equal(parseGitHubUrl(''), null)
})

test('repoOf and slugify normalize ids and names', () => {
  assert.equal(repoOf('https://github.com/a/b/tree/x/y'), 'a/b')
  assert.equal(repoOf('a/b'), 'a/b')
  assert.equal(slugify('PDF Form Filling!'), 'pdf-form-filling')
  assert.equal(slugify('  --  '), '')
})

test('normalizeRepo rejects bad coordinates', () => {
  assert.equal(normalizeRepo('Owner/Repo'), 'Owner/Repo')
  assert.equal(normalizeRepo('a/b/c'), null)
  assert.equal(normalizeRepo('a b/c'), null)
  assert.equal(normalizeRepo(undefined), null)
})

test('locateSkillDir resolves a hint, a unique name, or reports ambiguity', () => {
  const files = [
    { path: 'README.md', type: 'file' },
    { path: 'skills/pdf/SKILL.md', type: 'file' },
    { path: 'skills/pdf/other.md', type: 'file' },
    { path: 'deep/nested/SKILL.md', type: 'file' }
  ]
  assert.deepEqual(locateSkillDir(files, { hintPath: 'deep/nested' }), {
    dir: 'deep/nested',
    skillFile: 'deep/nested/SKILL.md'
  })
  assert.deepEqual(locateSkillDir(files, { name: 'pdf' }), { dir: 'skills/pdf', skillFile: 'skills/pdf/SKILL.md' })
  const ambiguous = locateSkillDir(files)
  assert.ok(Array.isArray(ambiguous?.ambiguous), 'two candidates must not be guessed')
  assert.equal(ambiguous.ambiguous.length, 2)
  assert.equal(locateSkillDir([{ path: 'a/README.md', type: 'file' }]), null)
})

test('parseFrontmatter reads name and description, quotes included', () => {
  const parsed = parseFrontmatter('---\nname: pdf\ndescription: "Fill PDF forms"\nextra: 1\n---\nbody')
  assert.deepEqual(parsed, { name: 'pdf', description: 'Fill PDF forms' })
  assert.deepEqual(parseFrontmatter('no frontmatter'), {})
})

test('dedupe collapses the same skill seen through several sources', () => {
  const merged = dedupe([
    { source: 'skillsmp', id: 'a', name: 'pdf', repo: 'anthropics/skills', path: 'skills/pdf', installs: 5 },
    { source: 'skillssh', id: 'anthropics/skills/pdf', name: 'pdf', repo: 'anthropics/skills', installs: 100 },
    { source: 'github', id: 'gh:a/b', name: 'other', repo: 'a/b', stars: 7 }
  ])
  assert.equal(merged.length, 2)
  const pdf = merged.find((item) => item.repo === 'anthropics/skills')
  assert.ok(pdf, 'pdf entry survives')
  assert.deepEqual(new Set(pdf.tags), new Set(['skillssh', 'skillsmp']), 'both sightings are recorded')
  assert.equal(pdf.path, 'skills/pdf', 'the install coordinate is backfilled from the weaker sighting')
})

test('rank pushes installable, popular entries to the front', () => {
  const ranked = rank([
    { source: 'github', id: 'x', name: 'x' },
    { source: 'skillssh', id: 'y', name: 'y', repo: 'a/b', installs: 900 },
    { source: 'skillstore', id: 'z', name: 'z', repo: 'c/d', stars: 3 }
  ])
  assert.equal(ranked[0].name, 'y')
  assert.equal(ranked.at(-1).name, 'x')
})

test('clamp and pageWindow bound marketplace paging', () => {
  assert.equal(clamp(99, 1, 25), 25)
  assert.equal(clamp('x', 1, 25), 1, 'non-numeric input falls back to the floor')
  assert.equal(pageWindow({ limit: 100 }, 10).limit, 50)
  assert.equal(pageWindow({}, 10).limit, 10)
  assert.equal(pageWindow({ page: 3, limit: 5 }).offset, 10)
})

test('validateSkillName keeps installs inside the skills root', () => {
  assert.equal(validateSkillName('pdf'), 'pdf')
  assert.equal(validateSkillName('pdf-form_filler.v2'), 'pdf-form_filler.v2')
  assert.throws(() => validateSkillName('../escape'))
  assert.throws(() => validateSkillName('a/b'))
  assert.throws(() => validateSkillName(''))
})

test('registry round-trips through a temporary install root', async () => {
  const root = path.join(os.tmpdir(), `dsh-skill-market-test-${process.pid}-${Date.now()}`)
  try {
    assert.equal(resolveInstallRoot(root), path.resolve(root))
    const empty = await readRegistry(root)
    assert.deepEqual(empty.data.skills, {})
    empty.data.skills.pdf = { source: 'github', repo: 'anthropics/skills', commit: 'deadbeef' }
    await writeRegistry(root, empty.data)
    const again = await readRegistry(root)
    assert.equal(again.data.skills.pdf.repo, 'anthropics/skills')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

/** A stand-in for deps.http that answers GitHub search with canned items. */
function githubHttp(items, calls) {
  return async (input) => {
    calls.push(String(input))
    const body = JSON.stringify({ total_count: items.length, incomplete_results: false, items })
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body }
  }
}

const ghItem = (fullName, stars) => ({
  full_name: fullName,
  name: fullName.split('/')[1],
  description: `${fullName} skill`,
  html_url: `https://github.com/${fullName}`,
  owner: { login: fullName.split('/')[0] },
  default_branch: 'main',
  stargazers_count: stars,
  topics: ['agent-skills']
})

test('github search keeps every repo and gives each a unique id', async () => {
  const calls = []
  const http = githubHttp([ghItem('acme/skills', 10), ghItem('acme/other-skills', 5)], calls)
  const entries = await githubSearch({ query: 'regression-unique-ids', limit: 5 }, { http, tokens: {}, log: () => {} })
  assert.equal(entries.length, 2, 'an undefined id used to collapse the result map to one entry')
  assert.deepEqual(
    entries.map((entry) => entry.id).sort(),
    ['github:acme/other-skills', 'github:acme/skills'],
    'ids must be source-qualified and unique'
  )
  assert.deepEqual(
    entries.map((entry) => entry.repo),
    ['acme/skills', 'acme/other-skills'],
    'entries are ranked by stars'
  )
})

test('github search spends one request and reuses the short cache', async () => {
  const calls = []
  const http = githubHttp([ghItem('acme/skills', 10)], calls)
  const deps = { http, tokens: {}, log: () => {} }
  await githubSearch({ query: 'regression-cache', limit: 5 }, deps)
  assert.equal(calls.length, 1, 'anonymous quota is 10/min: one request per search')
  const again = await githubSearch({ query: 'regression-cache', limit: 5 }, deps)
  assert.equal(calls.length, 1, 'a repeated search must come from the cache')
  assert.equal(again[0].repo, 'acme/skills')
})


// ---------------------------------------------------------------------------
// Index-driven search (the plugin-market form: static index + local filtering)
// ---------------------------------------------------------------------------

function indexDoc(skills) {
  return JSON.stringify({ version: 1, generatedAt: new Date(0).toISOString(), count: skills.length, skills })
}

function fakeIndexResponse(text, { etag = '"v1"' } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? etag : null) },
    text: async () => text,
  }
}

test('parseIndexDocument accepts a document or a bare array and stamps missing ids', () => {
  const fromDoc = parseIndexDocument(
    indexDoc([
      { name: 'pdf', description: 'PDF things', source: 'github', repo: 'anthropics/skills', path: 'skills/pdf', installs: 5 },
      { name: '' },
      { not: 'a skill' }
    ])
  )
  assert.equal(fromDoc.entries.length, 1)
  assert.equal(fromDoc.entries[0].id, 'github:anthropics/skills/pdf')
  assert.equal(fromDoc.meta.skipped, 2)

  const fromArray = parseIndexDocument(JSON.stringify([{ name: 'excel', source: 'skillsmp' }]))
  assert.equal(fromArray.entries.length, 1)
  assert.equal(fromArray.entries[0].id, 'skillsmp:excel')
  assert.throws(() => parseIndexDocument('{"nope":true}'), /no "skills" array/)
  assert.throws(() => parseIndexDocument('not json'), /not valid JSON/)
})

test('searchIndex filters locally: every token must match, sources and limit apply', () => {
  const { entries } = parseIndexDocument(
    indexDoc([
      { name: 'pdf', description: 'Fill PDF forms', source: 'github', repo: 'anthropics/skills', installs: 900 },
      { name: 'pdf-tools', description: 'Merge pdf files', source: 'skillsmp', installs: 10 },
      { name: 'excel', description: 'Spreadsheet work', source: 'skillsmp' }
    ])
  )
  const all = searchIndex(entries, { query: 'pdf', limit: 10 })
  assert.deepEqual(all.map((entry) => entry.name), ['pdf', 'pdf-tools'])
  assert.deepEqual(
    searchIndex(entries, { query: 'pdf merge', limit: 10 }).map((entry) => entry.name),
    ['pdf-tools'],
    'tokens are ANDed'
  )
  assert.deepEqual(
    searchIndex(entries, { query: 'pdf', sources: ['skillsmp'], limit: 10 }).map((entry) => entry.name),
    ['pdf-tools'],
    'source filter is honoured'
  )
  assert.equal(searchIndex(entries, { query: 'pdf', limit: 1 }).length, 1)
  assert.deepEqual(searchIndex(entries, { query: 'nothing-here', limit: 5 }), [])
})

test('createIndexStore reads a local file and searches it without any network', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-index-'))
  const file = path.join(dir, 'index.json')
  await fs.writeFile(
    file,
    indexDoc([{ name: 'slides', description: 'Build slide decks', source: 'github', repo: 'acme/decks', path: 'skills/slides' }])
  )
  let networkCalls = 0
  const store = createIndexStore({
    locations: [file],
    cacheDir: path.join(dir, 'cache'),
    http: async () => {
      networkCalls += 1
      throw new Error('should not hit the network for a local index')
    }
  })
  const loaded = await store.load()
  assert.equal(loaded.entries.length, 1)
  assert.equal(loaded.reports[0].from, 'disk')
  assert.deepEqual(searchIndex(loaded.entries, { query: 'slides', limit: 5 }).map((entry) => entry.repo), ['acme/decks'])
  assert.equal(networkCalls, 0)
  await fs.rm(dir, { recursive: true, force: true })
})

test('createIndexStore caches a remote index for the TTL and skips the second request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-index-'))
  const calls = []
  const http = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {} })
    return fakeIndexResponse(indexDoc([{ name: 'pdf', source: 'github', repo: 'anthropics/skills' }]))
  }
  const store = createIndexStore({
    locations: ['https://example.test/skill-index.json'],
    cacheDir: path.join(dir, 'cache'),
    ttlMs: 60_000,
    http
  })
  const first = await store.load()
  assert.equal(first.entries.length, 1)
  assert.equal(first.reports[0].from, 'network')
  assert.equal(calls.length, 1)

  const second = await store.load()
  assert.equal(second.reports[0].from, 'cache')
  assert.equal(calls.length, 1, 'within the TTL the cache answers')

  const forced = await store.load({ refresh: true })
  assert.equal(forced.reports[0].from, 'network')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].headers['if-none-match'], '"v1"', 'refresh revalidates with the stored ETag')

  const expired = createIndexStore({
    locations: ['https://example.test/skill-index.json'],
    cacheDir: path.join(dir, 'cache'),
    ttlMs: 0,
    http
  })
  await expired.load()
  assert.equal(calls.length, 3, 'a zero TTL always revalidates')
  await fs.rm(dir, { recursive: true, force: true })
})

test('one broken index location never sinks the others', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-index-'))
  const good = path.join(dir, 'good.json')
  await fs.writeFile(good, indexDoc([{ name: 'pdf', source: 'github', repo: 'a/b' }]))
  const store = createIndexStore({
    locations: [path.join(dir, 'missing.json'), good],
    cacheDir: path.join(dir, 'cache'),
    http: async () => {
      throw new Error('unused')
    }
  })
  const loaded = await store.load()
  assert.equal(loaded.entries.length, 1)
  assert.deepEqual(
    loaded.reports.map((report) => report.ok),
    [false, true]
  )
  await fs.rm(dir, { recursive: true, force: true })
})

test('serializeIndex round-trips through parseIndexDocument', () => {
  const { entries } = parseIndexDocument(
    indexDoc([{ name: 'pdf', description: 'PDF', source: 'github', repo: 'a/b', path: 'skills/pdf', installs: 3 }])
  )
  const text = serializeIndex({ queries: ['pdf'], sources: ['github'], skills: entries })
  const again = parseIndexDocument(text)
  assert.equal(again.entries.length, 1)
  assert.equal(again.entries[0].repo, 'a/b')
  assert.equal(again.entries[0].installs, 3)
  assert.deepEqual(JSON.parse(text).queries, ['pdf'])
})

test('buildIndex needs at least one query', async () => {
  await assert.rejects(() => buildIndex({ queries: [], deps: {} }), /at least one query/)
  await assert.rejects(() => buildIndex({ queries: ['   '], deps: {} }), /at least one query/)
})

const COMMIT = '0123456789abcdef0123456789abcdef01234567'
const pluginOptions = {
  name: 'dsh-skill-market',
  version: '0.1.0',
  title: 'Skill Market',
  description: 'Search and install agent skills',
  author: 'someone',
  keywords: ['skills', 'market'],
  source: { type: 'git', url: 'https://github.com/me/dsh-skill-market', commit: COMMIT },
  enginesDsh: '>=0.2.1-rc.3 <0.3.0',
  publishTimestamp: 1750000000,
}

test('pluginIndexDocument emits a format-1 index with a pinned git source', () => {
  const doc = pluginIndexDocument(pluginOptions)
  assert.equal(doc.format, 1)
  assert.deepEqual(doc.title, 'Skill Market')
  assert.equal(doc.plugins.length, 1)
  const plugin = doc.plugins[0]
  assert.equal(plugin.name, 'dsh-skill-market')
  assert.equal(plugin.versions.length, 1)
  assert.equal(plugin.versions[0].version, '0.1.0')
  assert.equal(plugin.versions[0].publishTimestamp, 1750000000)
  assert.deepEqual(plugin.versions[0].engines, { dsh: '>=0.2.1-rc.3 <0.3.0' })
  assert.deepEqual(plugin.versions[0].source, {
    type: 'git',
    url: 'https://github.com/me/dsh-skill-market',
    commit: COMMIT,
  })
  assert.deepEqual(plugin.metadata.keywords, ['skills', 'market'])
})

test('pluginIndexDocument supports localized text, an npm source and a monorepo path', () => {
  const localizedDoc = pluginIndexDocument({
    ...pluginOptions,
    title: { en: 'Skill Market', zh: '技能市场' },
    source: { type: 'git', url: 'https://github.com/me/mono', commit: COMMIT, path: 'packages/market' },
  })
  assert.deepEqual(localizedDoc.plugins[0].title, { en: 'Skill Market', zh: '技能市场' })
  assert.equal(localizedDoc.plugins[0].versions[0].source.path, 'packages/market')

  const npmDoc = pluginIndexDocument({ ...pluginOptions, source: { type: 'npm' } })
  assert.deepEqual(npmDoc.plugins[0].versions[0].source, { type: 'npm' })
})

test('pluginIndexDocument rejects what the official validator would reject', () => {
  assert.throws(() => pluginIndexDocument({ ...pluginOptions, version: 'v0.1' }), /exact SemVer/)
  assert.throws(
    () => pluginIndexDocument({ ...pluginOptions, source: { type: 'git', url: 'https://github.com/me/x', commit: 'abc' } }),
    /40-hex/
  )
  assert.throws(
    () => pluginIndexDocument({ ...pluginOptions, source: { type: 'git', url: 'http://github.com/me/x', commit: COMMIT } }),
    /must use https:/
  )
  assert.throws(
    () => pluginIndexDocument({ ...pluginOptions, source: { type: 'git', url: 'https://github.com/me/x', commit: COMMIT, path: '../x' } }),
    /without \. or \.\. segments/
  )
  assert.throws(() => pluginIndexDocument({ ...pluginOptions, title: { zh: '只有中文' } }), /must contain en/)
  assert.throws(() => pluginIndexDocument({ ...pluginOptions, name: 'Bad Name' }), /valid npm package name/)
  assert.throws(() => pluginIndexDocument({ ...pluginOptions, publishTimestamp: -1 }), /Unix seconds/)
})

test('normalizeRemoteUrl turns git remotes into canonical https URLs', () => {
  assert.equal(normalizeRemoteUrl('git@github.com:me/dsh-skill-market.git'), 'https://github.com/me/dsh-skill-market.git')
  assert.equal(normalizeRemoteUrl('ssh://git@github.com/me/dsh-skill-market.git'), 'https://github.com/me/dsh-skill-market.git')
  assert.equal(normalizeRemoteUrl('https://github.com/me/dsh-skill-market'), 'https://github.com/me/dsh-skill-market.git')
  assert.equal(normalizeRemoteUrl('https://token@github.com/me/x.git'), 'https://github.com/me/x.git')
  assert.equal(normalizeRemoteUrl('https://github.com/me/x.git'), 'https://github.com/me/x.git')
})

test('buildPluginIndex reads package.json and reports missing metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'market-plugin-'))
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'dsh-skill-market', version: '1.2.3', description: 'Search skills', engines: { dsh: '>=0.2 <0.3' } })
  )
  const { document, warnings } = buildPluginIndex({
    cwd: dir,
    repo: 'https://github.com/me/dsh-skill-market',
    commit: COMMIT,
  })
  assert.equal(document.plugins[0].name, 'dsh-skill-market')
  assert.equal(document.plugins[0].versions[0].version, '1.2.3')
  assert.deepEqual(document.plugins[0].versions[0].engines, { dsh: '>=0.2 <0.3' })
  assert.equal(document.plugins[0].repository.url, 'https://github.com/me/dsh-skill-market')
  assert.equal(warnings.length, 1, 'no keywords in package.json is reported')
  assert.match(warnings[0], /keywords/)
})

test('buildPluginIndex fails loudly without a repository or commit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'market-plugin-'))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
  assert.throws(() => buildPluginIndex({ cwd: dir }), /repository URL/)
  assert.throws(() => buildPluginIndex({ cwd: dir, repo: 'https://github.com/me/x' }), /git commit/)
  const npm = buildPluginIndex({ cwd: dir, sourceType: 'npm' })
  assert.deepEqual(npm.document.plugins[0].versions[0].source, { type: 'npm' })
})

test('serializePluginIndex writes JSON the market can parse', () => {
  const text = serializePluginIndex(pluginIndexDocument(pluginOptions))
  assert.ok(text.endsWith('\n'))
  const parsed = JSON.parse(text)
  assert.equal(parsed.format, 1)
  assert.equal(parsed.plugins[0].name, 'dsh-skill-market')
})

test('looksLikeSemverRange accepts ranges and rejects workspace protocol', () => {
  assert.equal(looksLikeSemverRange('>=0.2.1-rc.3 <0.3.0'), true)
  assert.equal(looksLikeSemverRange('^0.2.1'), true)
  assert.equal(looksLikeSemverRange('workspace:*'), false)
  assert.equal(looksLikeSemverRange(''), false)
})

test('cli parseArgs splits command, positional and flags', () => {
  const args = parseArgs(['search', 'pdf', 'form', '--limit', '5', '--json', '--index', 'a.json,b.json'])
  assert.equal(args.command, 'search')
  assert.deepEqual(args.positional, ['pdf', 'form'])
  assert.equal(args.flags.limit, '5')
  assert.equal(args.flags.json, true)
  assert.deepEqual(args.flags.index, ['a.json', 'b.json'])
})

test('cli resolveTarget maps names and passes explicit paths through', () => {
  const seen = []
  const exists = (p) => {
    seen.push(p)
    return false
  }
  assert.equal(resolveTarget('claude', { exists }).endsWith(path.join('.claude', 'skills')), true)
  assert.equal(resolveTarget('nested/base', { exists }), path.resolve('nested/base'))
  const fallback = resolveTarget(undefined, { exists })
  assert.equal(fallback.endsWith(path.join('.dsh', 'skills')), true)
})

test('cli resolveTarget covers the host directory table and its env overrides', () => {
  const exists = () => false
  const home = os.homedir()
  const cases = {
    dsh: ['.dsh', 'skills'],
    agents: ['.agents', 'skills'],
    claude: ['.claude', 'skills'],
    codex: ['.codex', 'skills'],
    cursor: ['.cursor', 'skills'],
    gemini: ['.gemini', 'skills'],
    copilot: ['.copilot', 'skills'],
    cline: ['.cline', 'skills'],
    roo: ['.roo', 'skills'],
    continue: ['.continue', 'skills'],
    qwen: ['.qwen', 'skills'],
    windsurf: ['.codeium', 'windsurf', 'skills'],
  }
  for (const [name, parts] of Object.entries(cases)) {
    assert.equal(resolveTarget(name, { exists }), path.join(home, ...parts), name)
  }
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = path.join(home, 'custom-codex')
  try {
    assert.equal(resolveTarget('codex', { exists }), path.join(home, 'custom-codex', 'skills'))
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
  }
})

test('cli coordinateEntry parses repo, repo/path and GitHub URLs', () => {
  const plain = coordinateEntry('anthropics/skills/pdf')
  assert.equal(plain.repo, 'anthropics/skills')
  assert.equal(plain.path, 'pdf')
  assert.equal(plain.name, 'pdf')

  const repoOnly = coordinateEntry('tw93/Kami')
  assert.equal(repoOnly.repo, 'tw93/Kami')
  assert.equal(repoOnly.path, undefined)
  assert.equal(repoOnly.name, 'kami')

  const url = coordinateEntry('https://github.com/openai/skills/tree/main/skills/playwright')
  assert.equal(url.repo, 'openai/skills')
  assert.equal(url.ref, 'main')
  assert.equal(url.path, 'skills/playwright')
  assert.equal(url.name, 'playwright')

  assert.throws(() => coordinateEntry('justoneword'), /expected owner\/repo/)
  assert.equal(coordinateEntry('anthropics/skills/pdf', { name: 'my-pdf' }).name, 'my-pdf')
})

test('cli formatTable prints rows and truncation hint', () => {
  const rows = [
    { name: 'pdf', source: 'skillsmp', description: 'work with pdf', repo: 'a/b', path: 'skills/pdf' },
    { name: 'excel', source: 'skillsmp', description: 'work with excel' },
  ]
  const text = formatTable(rows)
  assert.match(text, /pdf/)
  assert.match(text, /a\/b\/skills\/pdf/)
  assert.match(formatTable(rows, { max: 1 }), /1 more/)
  assert.equal(formatTable([]), 'no results')
})
