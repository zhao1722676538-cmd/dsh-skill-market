/**
 * dsh-skill-market — host plugin.
 *
 * Search skillsmp / skillstore / skills.sh / GitHub for agent skills, then let
 * the user install or uninstall them into the local skills directory.
 *
 * @module dsh-skill-market
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

import { searchAll, SOURCES } from './sources/index.js'
import { createIndexStore, searchIndex, mergeResults, serializeIndex } from './index-store.js'
import { buildIndex } from './index-build.js'
import { installSkill, uninstallSkill, listInstalled } from './install/installer.js'
import { createHttp } from './net.js'
import { registerTools } from './tools.js'
import { mountRoutes } from './routes.js'

export const name = 'skill-market'
export const inject = ['tools']

export const Config = z.object({
  enabled: z.boolean().default(true),
  installRoot: z.string().default(''),
  sources: z.array(z.string()).default(['skillsmp', 'skillstore', 'skillssh', 'github']),
  perSourceLimit: z.number().default(10),
  timeoutMs: z.number().default(15000),
  skillsmpApiKey: z.string().default(''),
  githubToken: z.string().default(''),
  allowOverwrite: z.boolean().default(false),
  indexes: z.array(z.string()).default([]),
  indexTtlMs: z.number().default(21600000),
  indexCacheDir: z.string().default(''),
  indexFallbackLive: z.boolean().default(true),
  mountRoutes: z.boolean().default(true),
  routePrefix: z.string().default('/dsh-skill-market'),
})

export const SOURCE_IDS = Object.keys(SOURCES)

/** net.js 依赖 AbortSignal.any（Node 20.3+）；更老的运行时会在第一次请求时才炸，提前拦。 */
export const MIN_NODE = '20.3'

function nodeVersionOk() {
  const [major, minor] = String(process.versions.node)
    .split('.')
    .map((part) => Number(part))
  return major > 20 || (major === 20 && minor >= 3)
}

/**
 * @param {any} ctx cordis context
 * @param {Partial<typeof Config>} [raw]
 */
export function apply(ctx, raw = {}) {
  const settings = resolveSettings(raw)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('skill-market') : ctx.logger
  const log = (message) => logger?.info?.(message)
  const warn = (message) => logger?.warn?.(message)

  if (!settings.enabled) {
    log('disabled by config')
    return
  }

  if (!nodeVersionOk()) {
    warn(`skipped: Node ${process.versions.node} is too old (needs >=${MIN_NODE} for AbortSignal.any + fetch)`)
    return
  }

  const deps = {
    http: createHttp({ timeoutMs: settings.timeoutMs, log }),
    tokens: { skillsmp: settings.skillsmpApiKey, github: settings.githubToken },
    log,
  }
  const indexStore = createIndexStore({
    locations: settings.indexes,
    ttlMs: settings.indexTtlMs,
    cacheDir: settings.indexCacheDir,
    http: deps.http,
    log,
  })
  const service = createService({ ctx, settings, deps, log, warn, indexStore })

  ctx.effect(() => registerTools(ctx, service))
  if (settings.mountRoutes) mountRouteLayer(ctx, service, settings, log, warn)

  log(
    `ready — sources=${settings.sources.join(',')} installRoot=${settings.installRoot}` +
      (settings.indexes.length > 0 ? ` indexes=${settings.indexes.length} (index-driven search)` : ' (live search)'),
  )
}

/** @param {any} raw */
function resolveSettings(raw) {
  const installRoot = typeof raw.installRoot === 'string' && raw.installRoot.trim() !== '' ? path.resolve(raw.installRoot.trim()) : defaultInstallRoot()
  const sources = normalizeSources(raw.sources)
  return {
    enabled: raw.enabled !== false,
    installRoot,
    sources,
    perSourceLimit: clampInt(raw.perSourceLimit, 10, 1, 25),
    timeoutMs: clampInt(raw.timeoutMs, 15000, 1000, 120000),
    skillsmpApiKey: typeof raw.skillsmpApiKey === 'string' ? raw.skillsmpApiKey.trim() : '',
    githubToken: typeof raw.githubToken === 'string' ? raw.githubToken.trim() : '',
    allowOverwrite: raw.allowOverwrite === true,
    indexes: Array.isArray(raw.indexes) ? raw.indexes.map((item) => String(item).trim()).filter(Boolean) : [],
    indexTtlMs: clampInt(raw.indexTtlMs, 21600000, 0, 30 * 24 * 60 * 60 * 1000),
    indexCacheDir: typeof raw.indexCacheDir === 'string' ? raw.indexCacheDir.trim() : '',
    indexFallbackLive: raw.indexFallbackLive !== false,
    mountRoutes: raw.mountRoutes !== false,
    routePrefix: typeof raw.routePrefix === 'string' && raw.routePrefix.trim() !== '' ? raw.routePrefix.trim() : '/dsh-skill-market',
  }
}

function defaultInstallRoot() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
  return path.join(home, 'skills')
}

function defaultCacheDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
  return path.join(home, 'cache', 'skill-market')
}

/** @param {unknown} value */
function normalizeSources(value) {
  const requested = Array.isArray(value) ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : []
  const enabled = requested.length === 0 ? SOURCE_IDS.slice() : requested.filter((id) => SOURCE_IDS.includes(id))
  return enabled.length === 0 ? SOURCE_IDS.slice() : enabled
}

/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * @param {{ctx: any, settings: any, deps: any, log: (m: string) => void, warn: (m: string) => void, indexStore?: any}} options
 */
function createService(options) {
  const { ctx, settings, deps, log, warn, indexStore } = options

  const service = {
    settings,

    /** All source descriptors, for the UI. */
    sourcesMeta() {
      return SOURCE_IDS.map((id) => {
        const source = SOURCES[id]
        return {
          id,
          label: source?.label ?? id,
          home: source?.home ?? '',
          enabled: settings.sources.includes(id),
          note: source?.note ?? '',
        }
      })
    },

    /** How search currently resolves results. */
    indexMeta() {
      return {
        indexes: settings.indexes.length,
        locations: settings.indexes,
        ttlMs: settings.indexTtlMs,
        fallbackLive: settings.indexFallbackLive,
        cacheDir: indexStore?.cacheDir ?? '',
        mode: settings.indexes.length > 0 ? 'index' : 'live',
      }
    },

    /**
     * Force a re-fetch of every configured index document.
     * @param {{refresh?: boolean}} [opts]
     */
    async loadIndex(opts = {}) {
      if (!indexStore || settings.indexes.length === 0) return { entries: [], reports: [] }
      return indexStore.load({ refresh: opts.refresh === true })
    },

    /**
     * Search: index-first when indexes are configured, live marketplaces
     * otherwise. `mode` says which path answered.
     * @param {{query: string, sources?: string[], limit?: number, refresh?: boolean}} request
     */
    async search(request) {
      const query = String(request?.query ?? '').trim()
      if (query === '') throw new Error('query is required')
      const requested = Array.isArray(request?.sources) && request.sources.length > 0 ? request.sources : settings.sources
      const sources = requested.map((id) => String(id).trim().toLowerCase()).filter((id) => SOURCE_IDS.includes(id))
      if (sources.length === 0) throw new Error(`no known source in: ${requested.join(', ')} (known: ${SOURCE_IDS.join(', ')})`)
      const limit = clampInt(request?.limit, settings.perSourceLimit, 1, 25)

      if (!indexStore || settings.indexes.length === 0) {
        const outcome = await searchAll({ query, sources, limit, timeoutMs: settings.timeoutMs }, deps)
        return { ...outcome, mode: 'live' }
      }

      let loaded = { entries: [], reports: [], summary: { locations: 0, entries: 0 } }
      try {
        loaded = await indexStore.load({ refresh: request?.refresh === true })
      } catch (err) {
        warn(`index load failed — falling back to live search: ${err?.message ?? String(err)}`)
      }

      const indexed = searchIndex(loaded.entries, { query, sources, limit })
      if (indexed.length > 0) {
        return {
          items: indexed,
          reports: [],
          mode: 'index',
          index: { locations: loaded.reports.length, entries: loaded.entries.length, reports: loaded.reports },
        }
      }
      if (!settings.indexFallbackLive) {
        return {
          items: [],
          reports: [],
          mode: 'index',
          index: { locations: loaded.reports.length, entries: loaded.entries.length, reports: loaded.reports },
        }
      }

      const live = await searchAll({ query, sources, limit, timeoutMs: settings.timeoutMs }, deps)
      return {
        items: mergeResults(indexed, live.items, { query, limit: limit * 2 }),
        reports: live.reports,
        mode: 'index+live',
        index: { locations: loaded.reports.length, entries: loaded.entries.length, reports: loaded.reports },
      }
    },

    /**
     * Build a static index from live searches and optionally write it to disk.
     * @param {{queries: string[], sources?: string[], limit?: number, outPath?: string}} args
     */
    async buildIndexDocument(args = {}) {
      const queries = (Array.isArray(args.queries) ? args.queries : [args.queries])
        .map((query) => String(query ?? '').trim())
        .filter(Boolean)
      if (queries.length === 0) throw new Error('at least one query is required')
      const sources = Array.isArray(args.sources) && args.sources.length > 0
        ? args.sources.map((id) => String(id).trim().toLowerCase()).filter((id) => SOURCE_IDS.includes(id))
        : settings.sources
      const limit = clampInt(args.limit, 10, 1, 50)
      const index = await buildIndex({ queries, sources, perSourceLimit: limit, deps, log })
      const text = serializeIndex(index)
      const outPath =
        typeof args.outPath === 'string' && args.outPath.trim() !== ''
          ? path.resolve(args.outPath.trim())
          : path.join(indexStore?.cacheDir ?? defaultCacheDir(), 'skill-index.json')
      await fs.mkdir(path.dirname(outPath), { recursive: true })
      // Regenerating over an existing index is normal, but silently shrinking a
      // hand-curated index to a handful of entries is a foot-gun worth flagging.
      let warning
      try {
        const existing = JSON.parse(await fs.readFile(outPath, 'utf8'))
        const before = Array.isArray(existing?.skills) ? existing.skills.length : 0
        if (before > 0 && index.skills.length < before / 2) {
          warning = `replaced an index of ${before} entries with only ${index.skills.length}; pass more --query terms to keep coverage`
        }
      } catch {
        // no previous index — nothing to compare against
      }
      await fs.writeFile(outPath, text)
      return { path: outPath, count: index.skills.length, bytes: Buffer.byteLength(text), reports: index.reports, warning }
    },

    /**
     * Turn loose tool arguments into an installable entry.
     * @param {{name?: string, source?: string, id?: string, repo?: string, path?: string, ref?: string}} args
     */
    async resolveEntry(args = {}) {
      const repo = typeof args.repo === 'string' ? args.repo.trim() : ''
      const hintName = normalizeSkillName(typeof args.name === 'string' ? args.name : '')

      if (repo.includes('/')) {
        return {
          source: normalizeSourceId(args.source),
          id: typeof args.id === 'string' && args.id !== '' ? args.id : `github:${repo}`,
          name: hintName || normalizeSkillName(repo.split('/').pop() ?? '') || 'skill',
          description: '',
          repo,
          ref: typeof args.ref === 'string' && args.ref !== '' ? args.ref : undefined,
          path: typeof args.path === 'string' && args.path !== '' ? normalizeRepoPath(args.path) : undefined,
        }
      }

      const source = normalizeSourceId(args.source)
      const id = typeof args.id === 'string' ? args.id.trim() : ''

      // skills.sh ids look like "owner/repo/skill-id" and carry the repo directly.
      if (source === 'skillssh' && id.split('/').filter(Boolean).length >= 3) {
        const parts = id.split('/').filter(Boolean)
        return {
          source,
          id,
          name: hintName || normalizeSkillName(parts[parts.length - 1]) || 'skill',
          description: '',
          repo: `${parts[0]}/${parts[1]}`,
          ref: typeof args.ref === 'string' && args.ref !== '' ? args.ref : undefined,
          path: undefined,
        }
      }

      const query = hintName || id || repo
      if (query === '') {
        throw new Error('need a skill to install: pass `repo` ("owner/name"), or `source` + `id` (or `name`) from skill_market_search')
      }
      const outcome = await service.search({ query, sources: source ? [source] : settings.sources, limit: 15 })
      const hit =
        (id !== '' ? outcome.items.find((item) => item.id === id) : undefined) ??
        (hintName !== '' ? outcome.items.find((item) => normalizeSkillName(item.name) === hintName) : undefined) ??
        (id !== '' ? outcome.items.find((item) => item.id.endsWith(id)) : undefined)
      if (!hit || !hit.repo) {
        const errors = outcome.reports.filter((report) => !report.ok).map((report) => `${report.source}: ${report.error}`)
        throw new Error(
          `cannot resolve an install coordinate for ${source ?? 'any source'}:${id || query}` +
            (errors.length > 0 ? ` (${errors.join(' | ')})` : '') +
            '. Pass `repo` explicitly, e.g. repo="anthropics/skills" path="skills/pdf" name="pdf".',
        )
      }
      return {
        ...hit,
        name: hintName || normalizeSkillName(hit.name) || 'skill',
        ref: typeof args.ref === 'string' && args.ref !== '' ? args.ref : hit.ref,
      }
    },

    /**
     * @param {any} entry
     * @param {{overwrite?: boolean}} [opts]
     */
    async install(entry, opts = {}) {
      const result = await installSkill(entry, {
        installRoot: settings.installRoot,
        deps,
        overwrite: opts.overwrite === true || settings.allowOverwrite,
      })
      const refreshed = await refreshSkills(ctx, warn)
      result.refreshed = refreshed
      log(`installed ${result.name} from ${result.repo ?? entry.source}@${result.commit ?? '?'} → ${result.dir}`)
      return result
    },

    /** @param {string} skillName @param {{force?: boolean}} [opts] */
    async uninstall(skillName, opts = {}) {
      const result = await uninstallSkill(skillName, { installRoot: settings.installRoot, force: opts.force === true })
      if (result.ok) {
        result.refreshed = await refreshSkills(ctx, warn)
        log(`uninstalled ${skillName}`)
      }
      return result
    },

    /** @param {boolean} includeUnmanaged */
    async list(includeUnmanaged = true) {
      const installed = (await listInstalled({ installRoot: settings.installRoot })).map((item) => ({
        name: item.name,
        source: item.source,
        repo: item.repo,
        commit: item.commit,
        installedAt: item.installedAt,
        present: item.present !== false,
        dir: item.dir ?? path.join(settings.installRoot, item.name),
      }))
      const managed = new Set(installed.map((item) => item.name))
      const unmanaged = includeUnmanaged ? await scanUnmanaged(settings.installRoot, managed) : []
      return {
        summary: `${installed.length} managed skill(s)${unmanaged.length > 0 ? `, ${unmanaged.length} unmanaged` : ''}`,
        installed,
        unmanaged,
        root: settings.installRoot,
      }
    },

    /** @param {any} result */
    installHint(result) {
      if (result?.refreshed) return 'The skills registry was refreshed; the skill is usable in this turn.'
      return 'Restart DeepSeek Harness if the skill does not show up in the skill list.'
    },

    /** @param {any} result */
    uninstallHint(result) {
      if (result?.ok === false && result?.reason === 'modified') {
        return 'Files changed after install. Re-run with force to delete anyway, or uninstall the skill by hand.'
      }
      if (result?.ok === false && result?.reason === 'unknown') return 'That name is not managed by this plugin (see skill_market_list).'
      return ''
    },
  }

  return service
}

/**
 * Mount the UI routes; the webServer service may appear after this plugin.
 * @param {any} ctx @param {any} service @param {any} settings @param {(m: string) => void} log @param {(m: string) => void} warn
 */
function mountRouteLayer(ctx, service, settings, log, warn) {
  ctx.effect(() => {
    /** @type {(() => void)[]} */
    const disposers = []
    const mountFor = (server) => {
      if (!server || typeof server.register !== 'function') return false
      try {
        const dispose = mountRoutes({ server, settings, service, log, warn })
        if (typeof dispose === 'function') disposers.push(dispose)
        log(`routes mounted under ${settings.routePrefix}`)
        return true
      } catch (err) {
        warn(`failed to mount routes: ${err?.stack ?? err}`)
        return false
      }
    }

    // cordis throws on an undeclared service property; only the read-through
    // lookup is safe here, and the dynamic inject below is the supported path.
    const direct = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (!mountFor(direct) && typeof ctx.inject === 'function') {
      const off = ctx.inject(['webServer'], (scoped) => {
        mountFor(typeof scoped.get === 'function' ? scoped.get('webServer') : undefined)
      })
      if (typeof off === 'function') disposers.push(off)
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* best effort */
        }
      }
      disposers.length = 0
    }
  })
}

/**
 * Ask the skills registry to pick up the new directory. Every DSH build names
 * this differently, so probe for the known spellings and never fail the install.
 * @param {any} ctx @param {(m: string) => void} warn
 */
async function refreshSkills(ctx, warn) {
  // `skills` is not an injected service for this plugin: read it through the
  // lookup so a composition without the skill registry cannot throw here.
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills) return false
  let done = false
  // The real registry (@deepseek-ai/dsh-skill) exposes invalidateCache() and
  // notifyChange(); filesystem providers keep watchers on their roots, so a
  // cache drop is what makes an installed skill visible without a restart.
  for (const method of ['invalidateCache', 'notifyChange']) {
    const fn = skills[method]
    if (typeof fn !== 'function') continue
    try {
      fn.call(skills)
      done = true
    } catch (err) {
      warn(`skills.${method}() failed: ${err?.message ?? err}`)
    }
  }
  if (done) return true
  for (const method of ['refresh', 'rescan', 'scan', 'reload', 'reloadSkills', 'invalidate']) {
    const fn = skills[method]
    if (typeof fn !== 'function') continue
    try {
      await fn.call(skills)
      return true
    } catch (err) {
      warn(`skills.${method}() failed: ${err?.message ?? err}`)
    }
  }
  try {
    ctx.emit?.('skills/change')
    return true
  } catch {
    return false
  }
}

/**
 * Directories under installRoot that have a SKILL.md but are not in our registry.
 * @param {string} installRoot @param {Set<string>} managed
 */
async function scanUnmanaged(installRoot, managed) {
  /** @type {{name: string, dir: string}[]} */
  const found = []
  let entries
  try {
    entries = await fs.readdir(installRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || managed.has(entry.name)) continue
    const dir = path.join(installRoot, entry.name)
    try {
      const stat = await fs.stat(path.join(dir, 'SKILL.md'))
      if (stat.isFile()) found.push({ name: entry.name, dir })
    } catch {
      /* not a skill directory */
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** @param {unknown} value */
function normalizeSourceId(value) {
  const id = String(value ?? '').trim().toLowerCase()
  return SOURCE_IDS.includes(id) ? id : 'github'
}

/** @param {string} value */
function normalizeSkillName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
}

/** @param {string} value */
function normalizeRepoPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
}
