/**
 * GitHub source adapter — finds skill repositories through the public REST API.
 *
 * Verified against the live API on 2026-10-28 (anonymous):
 *   GET https://api.github.com/search/repositories?q=pdf+topic:agent-skills
 *   -> { total_count, incomplete_results, items: [ { full_name, name, description,
 *        html_url, owner: { login }, default_branch, stargazers_count, topics, ... } ] }
 * Anonymous quota is 10 search requests/minute and 60 core requests/hour, so one
 * search must spend one request: the primary query is a single topic query, and a
 * second topic is only tried when the first came back empty. `config.githubToken`
 * raises quota to 5000 req/h and enables code search (`filename:SKILL.md`, which
 * requires authentication).
 *
 * @module dsh-skill-market/sources/github
 */

import { httpJson } from '../net.js'
import { firstNumber, firstString, repoOf } from './util.js'

export const id = 'github'
export const label = 'GitHub'
export const home = 'https://github.com'
export const capabilities = { search: true, browse: false, detail: false }

const API = 'https://api.github.com'
const TOPICS = ['agent-skills', 'claude-skills', 'skills']

/** Search results are stable for minutes; caching keeps the tiny quota usable. */
const CACHE_TTL_MS = 300_000
/** @type {Map<string, { at: number, entries: import('../types.js').SkillEntry[] }>} */
const searchCache = new Map()

/**
 * @param {import('../types.js').SearchQuery} q
 * @param {import('../types.js').SourceDeps} deps
 * @returns {Promise<import('../types.js').SkillEntry[]>}
 */
export async function search(q, deps) {
  const query = String(q?.query ?? '').trim()
  if (query === '') throw new Error('github: 搜索词不能为空')

  const limit = Math.max(1, Math.min(30, Math.trunc(Number(q?.limit) || 10)))
  const perPage = Math.max(3, Math.min(30, limit))
  const token = deps?.tokens?.github
  const headers = token ? { authorization: `Bearer ${token}` } : undefined

  const cacheKey = `gh:${limit}:${query.toLowerCase()}`
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries.map((entry) => ({ ...entry }))

  /** @type {Map<string, import('../types.js').SkillEntry>} */
  const found = new Map()
  const failures = []

  const request = async (term) => {
    const url = new URL(`${API}/search/repositories`)
    url.searchParams.set('q', term)
    url.searchParams.set('sort', 'stars')
    url.searchParams.set('order', 'desc')
    url.searchParams.set('per_page', String(perPage))
    const payload = await httpJson(deps.http, url, { headers, signal: q?.signal, timeoutMs: 12000 })
    for (const item of Array.isArray(payload?.items) ? payload.items : []) {
      const entry = toEntry(item)
      if (entry && !found.has(entry.id)) found.set(entry.id, entry)
    }
  }

  // Token holders have room for a broad query plus every topic; anonymous users
  // get one request, and a second topic only when the first returned nothing.
  const primary = token
    ? [`${query} in:name,description skill`, ...TOPICS.map((topic) => `${query} topic:${topic}`)]
    : [`${query} topic:${TOPICS[0]}`]

  for (const term of primary) {
    if (found.size >= limit) break
    try {
      await request(term)
    } catch (err) {
      failures.push(err?.message ?? String(err))
      break
    }
  }

  if (!token && found.size === 0 && failures.length === 0) {
    try {
      await request(`${query} topic:${TOPICS[1]}`)
    } catch (err) {
      failures.push(err?.message ?? String(err))
    }
  }

  if (token) {
    try {
      const url = new URL(`${API}/search/code`)
      url.searchParams.set('q', `${query} filename:SKILL.md`)
      url.searchParams.set('per_page', String(Math.min(perPage, 10)))
      const payload = await httpJson(deps.http, url, { headers, signal: q?.signal, timeoutMs: 12000 })
      for (const item of Array.isArray(payload?.items) ? payload.items : []) {
        const entry = toCodeEntry(item)
        if (entry && !found.has(entry.id)) found.set(entry.id, entry)
      }
    } catch (err) {
      failures.push(`code search: ${err?.message ?? err}`)
    }
  } else {
    deps.log?.('github: 未配置 token，跳过 code search（filename:SKILL.md 需要认证）')
  }

  if (found.size === 0 && failures.length > 0) {
    const first = failures[0]
    const rateLimited = /\b(403|429)\b|rate limit/i.test(first)
    throw new Error(
      rateLimited
        ? 'github: 触发匿名速率限制（搜索接口约 10 次/分钟）—等约 1 分钟后重试，或在插件配置里填写 githubToken（5000 次/小时）'
        : `github: 所有查询均失败 — ${first}`,
    )
  }

  const entries = [...found.values()].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)).slice(0, limit)
  if (entries.length > 0) {
    searchCache.set(cacheKey, { at: Date.now(), entries })
    if (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value)
  }
  return entries
}

/** @param {any} item */
function toEntry(item) {
  const repo = repoOf(item?.full_name)
  if (!repo) return null
  return fin({
    id: `${id}:${repo}`,
    source: id,
    key: repo,
    name: repo.split('/')[1] ?? repo,
    title: firstString(item?.name, repo),
    description: firstString(item?.description) ?? '',
    author: firstString(item?.owner?.login, repo.split('/')[0]),
    repo,
    ref: firstString(item?.default_branch),
    url: firstString(item?.html_url),
    stars: firstNumber(item?.stargazers_count),
    tags: Array.isArray(item?.topics) && item.topics.length ? item.topics.slice(0, 8) : undefined,
  })
}

/** @param {any} item */
function toCodeEntry(item) {
  const repo = repoOf(item?.repository?.full_name)
  if (!repo) return null
  const filePath = firstString(item?.path)
  const dir = filePath ? filePath.replace(/(^|\/)SKILL\.md$/i, '').replace(/^\/+/, '') : undefined
  const key = `${repo}${dir ? `::${dir}` : ''}`
  return fin({
    id: `${id}:${key}`,
    source: id,
    key,
    name: (dir ? dir.split('/').pop() : repo.split('/')[1]) ?? repo,
    description: '',
    author: repo.split('/')[0],
    repo,
    path: dir || undefined,
    url: firstString(item?.html_url),
  })
}

/** @param {Record<string, unknown>} entry */
function fin(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined))
}

export default { id, label, home, capabilities, search }
