/**
 * Index-driven skill discovery.
 *
 * The plugin-market way: instead of asking four marketplaces on every search
 * (needs a GitHub token, hits anonymous rate limits, slow), load one or more
 * static index documents, keep them in a TTL cache, and search locally.
 *
 * An index document is plain JSON:
 *
 *   {
 *     "version": 1,
 *     "generatedAt": "2026-10-28T12:00:00.000Z",
 *     "count": 42,
 *     "skills": [
 *       {
 *         "name": "pdf",
 *         "description": "…",
 *         "source": "github",
 *         "id": "github:anthropics/skills|pdf",
 *         "repo": "anthropics/skills",
 *         "path": "document-skills/pdf",
 *         "ref": "main",
 *         "url": "https://github.com/anthropics/skills",
 *         "installs": 218410,
 *         "stars": 1234,
 *         "tags": ["pdf", "document"]
 *       }
 *     ]
 *   }
 *
 * Locations may be `http(s)://…`, `file://…`, or a plain filesystem path.
 * @module dsh-skill-market/index-store
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { dedupe, rank } from './sources/index.js'
import { slugify } from './sources/util.js'

export const INDEX_VERSION = 1

/** @param {string} location */
export function isRemoteLocation(location) {
  return /^https?:\/\//i.test(String(location ?? '').trim())
}

/** @param {string} location */
export function isFileLocation(location) {
  const value = String(location ?? '').trim()
  return value.startsWith('file://') || (!/^[a-z]+:\/\//i.test(value) && value !== '')
}

/** @param {string} location @returns {string} */
export function localPathOf(location) {
  const value = String(location ?? '').trim()
  if (value.startsWith('file://')) return decodeURIComponent(new URL(value).pathname).replace(/^\/([a-zA-Z]:)/, '$1')
  return value
}

/** @param {string} location */
function cacheKeyOf(location) {
  return crypto.createHash('sha256').update(String(location)).digest('hex').slice(0, 32)
}

/**
 * Trim one record from an index document into a SkillEntry. Unknown fields are
 * dropped, and a missing `id` is derived so every entry stays addressable.
 * @param {any} raw
 * @param {string} [origin]
 * @returns {import('./types.js').SkillEntry | null}
 */
export function normalizeIndexEntry(raw, origin = 'index') {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name ?? raw.title ?? '').trim()
  if (name === '') return null
  const source = typeof raw.source === 'string' && raw.source !== '' ? raw.source : 'index'
  const repo = typeof raw.repo === 'string' && raw.repo !== '' ? raw.repo : undefined
  const key = typeof raw.key === 'string' && raw.key !== '' ? raw.key : repo ? `${repo}/${slugify(name)}` : slugify(name)
  return {
    source,
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `${source}:${key}`,
    key,
    name,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    description: typeof raw.description === 'string' ? raw.description : '',
    author: typeof raw.author === 'string' ? raw.author : undefined,
    repo,
    ref: typeof raw.ref === 'string' && raw.ref !== '' ? raw.ref : undefined,
    path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    installs: Number.isFinite(raw.installs) ? raw.installs : undefined,
    stars: Number.isFinite(raw.stars) ? raw.stars : undefined,
    risk: typeof raw.risk === 'string' ? raw.risk : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : undefined,
  }
}

/**
 * @param {string} text
 * @param {string} [origin]
 * @returns {{entries: import('./types.js').SkillEntry[], meta: Record<string, any>}}
 */
export function parseIndexDocument(text, origin = 'index') {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`index document is not valid JSON: ${err?.message ?? String(err)}`, { cause: err })
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.skills) ? parsed.skills : null
  if (!list) throw new Error('index document has no "skills" array')
  const entries = []
  let skipped = 0
  for (const raw of list) {
    const entry = normalizeIndexEntry(raw, origin)
    if (entry) entries.push(entry)
    else skipped += 1
  }
  return {
    entries,
    meta: {
      version: Number.isFinite(parsed?.version) ? parsed.version : INDEX_VERSION,
      generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : undefined,
      count: entries.length,
      skipped,
    },
  }
}

/**
 * Serialize a built index into the canonical document form.
 * @param {{version?: number, generatedAt?: string, queries?: string[], sources?: string[], skills: any[]}} index
 */
export function serializeIndex(index) {
  const skills = (index.skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description ?? '',
    source: skill.source,
    id: skill.id,
    key: skill.key,
    title: skill.title,
    author: skill.author,
    repo: skill.repo,
    ref: skill.ref,
    path: skill.path,
    url: skill.url,
    installs: skill.installs,
    stars: skill.stars,
    tags: skill.tags,
  }))
  const document = {
    version: index.version ?? INDEX_VERSION,
    generatedAt: index.generatedAt ?? new Date().toISOString(),
    generator: 'dsh-skill-market',
    queries: index.queries ?? [],
    sources: index.sources ?? [],
    count: skills.length,
    skills,
  }
  return `${JSON.stringify(document, undefined, 2)}\n`
}

/**
 * Filter + rank index entries locally. No network, no rate limit: this is the
 * whole point of the index form.
 * @param {import('./types.js').SkillEntry[]} entries
 * @param {{query: string, sources?: string[], limit?: number}} request
 * @returns {import('./types.js').SkillEntry[]}
 */
export function searchIndex(entries, request) {
  const query = String(request?.query ?? '').trim()
  const tokens = query
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((token) => token.length > 0)
  const requested = Array.isArray(request?.sources) && request.sources.length > 0 ? request.sources.map(String) : null
  const limit = Number.isFinite(request?.limit) && request.limit > 0 ? Math.trunc(request.limit) : 10

  const filtered = entries.filter((entry) => {
    if (requested && !requested.includes(entry.source)) return false
    if (tokens.length === 0) return true
    const haystack = [
      entry.name,
      entry.title ?? '',
      entry.description ?? '',
      entry.repo ?? '',
      entry.path ?? '',
      ...(entry.tags ?? []),
    ]
      .join(' ')
      .toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })

  return rank(filtered, { query, limit: limit * 2 }).slice(0, limit)
}

/**
 * @param {{locations?: string[], cacheDir?: string, ttlMs?: number, http?: any, log?: (m: string) => void}} options
 */
export function createIndexStore(options = {}) {
  const locations = (options.locations ?? []).map((location) => String(location).trim()).filter(Boolean)
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : 6 * 60 * 60 * 1000
  const cacheDir =
    typeof options.cacheDir === 'string' && options.cacheDir !== ''
      ? options.cacheDir
      : path.join(os.homedir(), '.dsh', 'cache', 'skill-market')
  const http = options.http
  const log = options.log ?? (() => {})

  /**
   * Load every configured index document, honoring the TTL cache and ETag.
   * One broken location never fails the whole load.
   * @param {{refresh?: boolean}} [opts]
   */
  async function load(opts = {}) {
    const reports = []
    /** @type {import('./types.js').SkillEntry[]} */
    const entries = []
    for (const location of locations) {
      const started = Date.now()
      try {
        const result = await loadOne(location, { refresh: opts.refresh === true })
        entries.push(...result.entries)
        reports.push({
          location,
          ok: true,
          count: result.entries.length,
          from: result.from,
          ms: Date.now() - started,
        })
      } catch (err) {
        const message = err?.message ?? String(err)
        log(`index ${location}: ${message}`)
        reports.push({ location, ok: false, error: message, count: 0, from: 'error', ms: Date.now() - started })
      }
    }
    return {
      entries,
      reports,
      summary: {
        locations: locations.length,
        entries: entries.length,
        generatedAt: reports.map((report) => (report.ok ? report.from : undefined)).filter(Boolean).length,
      },
    }
  }

  /**
   * @param {string} location
   * @param {{refresh: boolean}} opts
   */
  async function loadOne(location, opts) {
    if (isFileLocation(location)) {
      const filePath = localPathOf(location)
      const text = await fs.readFile(filePath, 'utf8')
      const { entries } = parseIndexDocument(text, filePath)
      return { entries, from: 'disk' }
    }
    if (!isRemoteLocation(location)) {
      throw new Error(`unsupported index location: ${location} (use an http(s) URL or a filesystem path)`)
    }
    if (typeof http !== 'function') throw new Error('no HTTP client available to fetch a remote index')

    const key = cacheKeyOf(location)
    const bodyPath = path.join(cacheDir, `${key}.json`)
    const metaPath = path.join(cacheDir, `${key}.meta.json`)
    let meta = null
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    } catch {
      meta = null
    }

    const fresh = meta !== null && !opts.refresh && Date.now() - Number(meta.fetchedAt ?? 0) < ttlMs
    if (fresh) {
      try {
        const text = await fs.readFile(bodyPath, 'utf8')
        const { entries } = parseIndexDocument(text, location)
        return { entries, from: 'cache' }
      } catch {
        meta = null // cache body vanished; fall through to the network
      }
    }

    const headers = {}
    // Validators make even a forced refresh cheap: the server may answer 304.
    if (meta?.etag) headers['if-none-match'] = meta.etag
    if (meta?.lastModified) headers['if-modified-since'] = meta.lastModified

    const response = await http(location, { headers })
    if (response.status === 304 && meta !== null) {
      const text = await fs.readFile(bodyPath, 'utf8')
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(
        metaPath,
        JSON.stringify({ ...meta, fetchedAt: Date.now() }, undefined, 2),
      )
      const { entries } = parseIndexDocument(text, location)
      return { entries, from: 'cache' }
    }
    if (!response.ok) throw new Error(`index request failed: HTTP ${response.status}`)
    const text = await response.text()
    const { entries } = parseIndexDocument(text, location)

    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(bodyPath, text)
    await fs.writeFile(
      metaPath,
      JSON.stringify(
        {
          location,
          fetchedAt: Date.now(),
          etag: response.headers?.get?.('etag') ?? null,
          lastModified: response.headers?.get?.('last-modified') ?? null,
        },
        undefined,
        2,
      ),
    )
    return { entries, from: 'network' }
  }

  return { load, locations, cacheDir, ttlMs }
}

/**
 * Merge index hits with live results, keeping the richer record of each skill.
 * @param {import('./types.js').SkillEntry[]} indexed
 * @param {import('./types.js').SkillEntry[]} live
 * @param {{query?: string, limit?: number}} [opts]
 */
export function mergeResults(indexed, live, opts = {}) {
  const merged = dedupe([...indexed, ...live])
  return rank(merged, { query: opts.query ?? '', limit: opts.limit })
}

export default { INDEX_VERSION, createIndexStore, parseIndexDocument, serializeIndex, searchIndex, mergeResults, normalizeIndexEntry }
