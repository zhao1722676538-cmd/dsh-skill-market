/**
 * SkillStore (skillstore.io) source adapter.
 *
 * Verified against the live API on 2026-10-28:
 *   GET https://skillstore.io/api/skills?q=pdf&limit=3
 *   -> { data: [ { slug, emoji, displayName, description, category, riskLevel,
 *                  hasScripts, needsNetwork, riskFactors, claude, codex, claudeCode,
 *                  license, repo, ref, aiTitle, aiDescription, author, githubUsername,
 *                  isFeatured, qualityScore, evidenceConfidence, updatedAt,
 *                  variantGroup, stats: { viewCount, downloadCount, favoriteCount,
 *                  popularityScore } } ],
 *        total, pagination: { page, limit, total, totalPages } }
 * `repo` is a GitHub URL, usually `https://github.com/<owner>/<repo>/tree/<ref>/<path>`,
 * so search already yields complete install coordinates; `resolve` only fills gaps
 * from `/api/skills/<slug>/manifest` (signed, immutable commit artifact).
 *
 * @module dsh-skill-market/sources/skillstore
 */

import { httpJson } from '../net.js'
import { firstNumber, firstString, pageWindow, parseGitHubUrl } from './util.js'

export const id = 'skillstore'
export const label = 'SkillStore'
export const home = 'https://skillstore.io'
export const capabilities = { search: true, browse: false, detail: true }

const SEARCH = `${home}/api/skills`

/**
 * @param {import('../types.js').SearchQuery} q
 * @param {import('../types.js').SourceDeps} deps
 * @returns {Promise<import('../types.js').SkillEntry[]>}
 */
export async function search(q, deps) {
  const query = String(q?.query ?? '').trim()
  if (query === '') throw new Error('skillstore: 搜索词不能为空')

  const { limit, page } = pageWindow(q, 10)
  const url = new URL(SEARCH)
  url.searchParams.set('q', query)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('page', String(page))

  const payload = await httpJson(deps.http, url, { signal: q?.signal, timeoutMs: 12000 })
  const rows = payload?.data
  if (!Array.isArray(rows)) throw new Error('skillstore: 响应缺少 data 数组')

  return rows.map((row) => toEntry(row)).filter(Boolean).slice(0, limit)
}

/**
 * Fill `repo/ref/path` from the signed manifest when search omitted them.
 * @param {import('../types.js').SkillEntry} entry
 * @param {import('../types.js').SourceDeps} deps
 */
export async function resolve(entry, deps) {
  if (entry?.repo) return entry
  const slug = entry?.key || entry?.id?.replace(/^skillstore:/, '')
  if (!slug) return entry
  try {
    const manifest = await httpJson(deps.http, `${SEARCH}/${encodeURIComponent(slug)}/manifest`, { timeoutMs: 12000 })
    const coords = parseGitHubUrl(manifest?.repo ?? manifest?.source?.repo ?? manifest?.source?.url)
    if (!coords?.repo) return entry
    return { ...entry, repo: coords.repo, ref: coords.ref ?? manifest?.ref ?? manifest?.source?.ref, path: coords.path }
  } catch (err) {
    deps.log?.(`skillstore: manifest lookup failed for ${slug}: ${err?.message ?? err}`)
    return entry
  }
}

/** @param {any} row */
function toEntry(row) {
  const slug = firstString(row?.slug)
  const name = firstString(row?.displayName, row?.aiTitle, slug)
  if (!slug || !name) return null
  const coords = parseGitHubUrl(row?.repo)
  const updated = Number(row?.updatedAt)
  const tags = [firstString(row?.category), ...(Array.isArray(row?.riskFactors) ? row.riskFactors : [])].filter(Boolean)
  return fin({
    source: id,
    key: slug,
    name,
    title: firstString(row?.aiTitle, row?.displayName),
    description: firstString(row?.aiDescription, row?.description) ?? '',
    author: firstString(row?.githubUsername, row?.author),
    repo: coords?.repo,
    ref: coords?.ref ?? firstString(row?.ref),
    path: coords?.path,
    url: `${home}/skills/${slug}`,
    risk: firstString(row?.riskLevel),
    installs: firstNumber(row?.stats?.downloadCount),
    stars: firstNumber(row?.stats?.popularityScore),
    updatedAt: Number.isFinite(updated) ? updated : undefined,
    tags: tags.length ? tags : undefined,
  })
}

/** @param {Record<string, unknown>} entry */
function fin(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined))
}

export default { id, label, home, capabilities, search, resolve }
