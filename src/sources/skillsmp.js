/**
 * SkillsMP source adapter.
 *
 * Verified against the live API on 2026-10-28:
 *   GET https://skillsmp.com/api/v1/skills/search?q=pdf&limit=3
 *   -> { success: true,
 *        data: { skills: [ { id, name, author, description, contentLanguage,
 *                            githubUrl, skillUrl, stars, updatedAt } ],
 *                pagination: { page, limit, total, totalPages, hasNext, hasPrev, totalIsTotalExact },
 *                filters: {...} },
 *        meta: { requestId, responseTimeMs } }
 * Anonymous quota is small (50/day, 10/min); `config.skillsmpApiKey` raises it.
 *
 * @module dsh-skill-market/sources/skillsmp
 */

import { httpJson } from '../net.js'
import { firstNumber, firstString, pageWindow, parseGitHubUrl } from './util.js'

export const id = 'skillsmp'
export const label = 'SkillsMP'
export const home = 'https://skillsmp.com'
export const capabilities = { search: true, browse: false, detail: true }

const ENDPOINT = `${home}/api/v1/skills/search`

/**
 * @param {import('../types.js').SearchQuery} q
 * @param {import('../types.js').SourceDeps} deps
 * @returns {Promise<import('../types.js').SkillEntry[]>}
 */
export async function search(q, deps) {
  const query = String(q?.query ?? '').trim()
  if (query === '') throw new Error('skillsmp: 搜索词不能为空')

  const { limit, offset } = pageWindow(q, 10)
  const url = new URL(ENDPOINT)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('offset', String(offset))
  const token = deps?.tokens?.skillsmp
  const headers = token ? { authorization: `Bearer ${token}` } : undefined

  const payload = await httpJson(deps.http, url, { headers, signal: q?.signal, timeoutMs: 12000 })
  const skills = payload?.data?.skills
  if (!Array.isArray(skills)) throw new Error('skillsmp: 响应缺少 data.skills')

  return skills.map((skill) => toEntry(skill)).filter(Boolean).slice(0, limit)
}

/**
 * @param {any} skill
 * @returns {import('../types.js').SkillEntry | null}
 */
function toEntry(skill) {
  const rawName = firstString(skill?.name, skill?.id)
  if (!rawName) return null
  const coords = parseGitHubUrl(skill?.githubUrl)
  const updated = Number(skill?.updatedAt)
  return fin({
    source: id,
    key: String(skill?.id ?? rawName),
    name: rawName,
    title: firstString(skill?.name),
    description: firstString(skill?.description) ?? '',
    author: firstString(skill?.author),
    repo: coords?.repo,
    ref: coords?.ref,
    path: coords?.path,
    url: firstString(skill?.skillUrl, skill?.githubUrl),
    stars: firstNumber(skill?.stars),
    updatedAt: Number.isFinite(updated) ? updated * 1000 : undefined,
    tags: firstString(skill?.contentLanguage) ? [firstString(skill?.contentLanguage)] : undefined,
  })
}

/** Drop undefined values so entries stay JSON-round-trippable. */
function fin(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined))
}

export default { id, label, home, capabilities, search }
