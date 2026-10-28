/**
 * Source registry: fan-out search, de-duplication and ranking.
 * @module dsh-skill-market/sources
 */

import * as skillsmp from './skillsmp.js'
import * as skillstore from './skillstore.js'
import * as skillssh from './skillssh.js'
import * as github from './github.js'
import { slugify } from './util.js'

/** @type {Record<import('../types.js').SourceId, Record<string, any>>} */
export const SOURCES = { skillsmp, skillstore, skillssh, github }

/** @typedef {keyof typeof SOURCES} SourceId */

/** @returns {{id: SourceId, label: string, home: string, capabilities: Record<string, boolean>}[]} */
export function listSources() {
  return Object.values(SOURCES).map((source) => ({
    id: source.id,
    label: source.label,
    home: source.home,
    capabilities: source.capabilities,
  }))
}

/**
 * @param {string} id
 * @returns {Record<string, any> | undefined}
 */
export function sourceOf(id) {
  const source = SOURCES[/** @type {SourceId} */ (id)]
  return source ? source : undefined
}

/**
 * Query every requested source concurrently. One failing source never fails the
 * whole search: its error lands in `reports` and the other results survive.
 * @param {import('../types.js').SearchQuery} q
 * @param {import('../types.js').SourceDeps} deps
 * @returns {Promise<import('../types.js').SearchOutcome>}
 */
export async function searchAll(q, deps) {
  const query = String(q?.query ?? '').trim()
  const requested = Array.isArray(q?.sources) && q.sources.length > 0
    ? q.sources.filter((id) => SOURCES[id])
    : Object.keys(SOURCES)
  const perSource = Math.max(1, Math.min(50, Math.trunc(Number(q?.limit) || 10)))

  const settled = await Promise.allSettled(
    requested.map(async (sourceId) => {
      const started = Date.now()
      try {
        const items = await SOURCES[sourceId].search({ ...q, query, limit: perSource }, deps)
        return { items, report: { source: sourceId, ok: true, count: items.length, ms: Date.now() - started } }
      } catch (err) {
        const message = err?.message ?? String(err)
        deps.log?.(`${sourceId}: search failed — ${message}`)
        return {
          items: [],
          report: { source: sourceId, ok: false, error: message, ms: Date.now() - started, count: 0 },
        }
      }
    }),
  )

  /** @type {import('../types.js').SkillEntry[]} */
  const items = []
  /** @type {import('../types.js').SearchOutcome['reports']} */
  const reports = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    items.push(...result.value.items.map(withId))
    reports.push(result.value.report)
    q?.onSource?.(result.value.report)
  }

  return { items: rank(dedupe(items), { query, limit: perSource * 2 }), reports }
}

/**
 * Every entry carries a globally unique `id` = `<source>:<key>`.
 * @param {import('../types.js').SkillEntry} item
 * @returns {import('../types.js').SkillEntry}
 */
function withId(item) {
  return item.id ? item : { ...item, id: `${item.source}:${item.key ?? slugify(item.name)}` }
}

/**
 * Collapse the same repo/path found through several sources, keeping the richer
 * record and remembering where else it was seen.
 * @param {import('../types.js').SkillEntry[]} items
 * @returns {import('../types.js').SkillEntry[]}
 */
export function dedupe(items) {
  /** @type {Map<string, import('../types.js').SkillEntry>} */
  const byKey = new Map()
  for (const item of items) {
    const key = dedupeKey(item)
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, item)
      continue
    }
    const winner = quality(existing) >= quality(item) ? existing : item
    const other = winner === existing ? item : existing
    const mergedTags = [...new Set([...(winner.tags ?? []), winner.source, other.source])].filter(Boolean)
    const merged = { ...winner, tags: mergedTags }
    // A weaker sighting may still carry the install coordinate the winner lacks
    // (skills.sh knows the repo, skillsmp knows the sub-directory).
    for (const field of ['path', 'repo', 'ref', 'url', 'description', 'installs', 'stars', 'risk']) {
      if (merged[field] === undefined || merged[field] === null || merged[field] === '') merged[field] = other[field]
    }
    byKey.set(key, merged)
  }
  return [...byKey.values()]
}

/** @param {import('../types.js').SkillEntry} item */
function dedupeKey(item) {
  // The same skill shows up in several marketplaces with the same repo + skill
  // name but different amounts of detail; path is never part of the identity.
  if (item.repo) return `${item.repo}|${slugify(item.name)}`
  return item.id ?? `${item.source}:${slugify(item.name)}`
}

/** @param {import('../types.js').SkillEntry} item */
function quality(item) {
  return (item.installs ?? 0) + (item.stars ?? 0) * 0.1 + (item.description ? 5 : 0)
}

/**
 * Rank by popularity plus a small textual-relevance bonus. Deterministic: equal
 * scores fall back to the name, so repeated searches return a stable order.
 * @param {import('../types.js').SkillEntry[]} items
 * @param {{query?: string, limit?: number}} [options]
 * @returns {import('../types.js').SkillEntry[]}
 */
export function rank(items, options = {}) {
  const tokens = String(options.query ?? '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((token) => token.length > 1)

  const scored = items.map((item) => {
    let score = Math.log1p(item.installs ?? 0) * 1.0 + Math.log1p(item.stars ?? 0) * 0.6
    if (tokens.length > 0) {
      const haystack = `${item.name} ${item.title ?? ''} ${item.description ?? ''}`.toLowerCase()
      for (const token of tokens) if (haystack.includes(token)) score += 2
    }
    return { item, score }
  })

  scored.sort((a, b) => (b.score - a.score) || a.item.name.localeCompare(b.item.name))
  const ranked = scored.map(({ item }) => item)
  const limit = Number(options.limit)
  return Number.isFinite(limit) && limit > 0 ? ranked.slice(0, limit) : ranked
}

export default { SOURCES, listSources, sourceOf, searchAll, dedupe, rank }
