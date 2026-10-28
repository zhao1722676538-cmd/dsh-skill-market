/**
 * skills.sh source adapter.
 *
 * Verified against the live API on 2026-10-28:
 *   GET https://skills.sh/api/search?q=pdf
 *   -> { query, searchType, searchVersion,
 *        skills: [ { id: "anthropics/skills/pdf", source: "anthropics/skills",
 *                    skillId: "pdf", name: "pdf", installs: 218410 } ],
 *        count, duration_ms, timings_ms, provider_duration_ms }
 * `q` must be at least 2 characters, otherwise the API answers 400 — we validate
 * locally so the user gets a readable message instead of a raw HTTP error.
 * Detail page: https://skills.sh/<owner>/<repo>/<skillId>. No token required.
 *
 * @module dsh-skill-market/sources/skillssh
 */

import { httpJson } from '../net.js'
import { firstNumber, firstString, repoOf } from './util.js'

export const id = 'skillssh'
export const label = 'skills.sh'
export const home = 'https://skills.sh'
export const capabilities = { search: true, browse: false, detail: true }

const SEARCH = `${home}/api/search`

/**
 * @param {import('../types.js').SearchQuery} q
 * @param {import('../types.js').SourceDeps} deps
 * @returns {Promise<import('../types.js').SkillEntry[]>}
 */
export async function search(q, deps) {
  const query = String(q?.query ?? '').trim()
  if (query.length < 2) throw new Error('skills.sh: 搜索词至少需要 2 个字符')

  const url = new URL(SEARCH)
  url.searchParams.set('q', query)

  const payload = await httpJson(deps.http, url, { signal: q?.signal, timeoutMs: 12000 })
  const rows = payload?.skills
  if (!Array.isArray(rows)) throw new Error('skills.sh: 响应缺少 skills 数组')

  const limit = Math.max(1, Math.min(50, Math.trunc(Number(q?.limit) || 10)))
  return rows.map((row) => toEntry(row)).filter(Boolean).slice(0, limit)
}

/** @param {any} row */
function toEntry(row) {
  const name = firstString(row?.name, row?.skillId)
  if (!name) return null
  const repo = repoOf(row?.source) ?? repoOf(row?.id)
  const skillId = firstString(row?.skillId, row?.name)
  const url = repo && skillId ? `${home}/${repo}/${skillId}` : repo ? `${home}/${repo}` : firstString(row?.id)
  return fin({
    source: id,
    key: firstString(row?.id, `${repo ?? 'unknown'}/${skillId ?? name}`),
    name,
    description: '',
    repo,
    // path is unknown until the installer walks the repo tree for SKILL.md
    url,
    installs: firstNumber(row?.installs),
  })
}

/** @param {Record<string, unknown>} entry */
function fin(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined))
}

export default { id, label, home, capabilities, search }
