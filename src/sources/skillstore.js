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
import { verifySkillStoreManifest } from './skillstore-signature.js'

export const id = 'skillstore'
export const label = 'SkillStore'
export const home = 'https://skillstore.io'
export const capabilities = { search: true, browse: false, detail: true, verifiedArtifacts: true, resolve: true }

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
 * Verify the signed install manifest and fill `repo/ref/path` from its immutable
 * artifact coordinates. Verification is mandatory for installs from this source.
 * @param {import('../types.js').SkillEntry} entry
 * @param {import('../types.js').SourceDeps} deps
 */
export async function resolve(entry, deps) {
  const slug = entry?.key || entry?.id?.replace(/^skillstore:/, '')
  if (!slug || slug.includes('/') || slug.startsWith('github:')) {
    throw new Error('SkillStore install requires the slug from a skill_market_search result')
  }
  const manifest = await httpJson(deps.http, `${SEARCH}/${encodeURIComponent(slug)}/manifest`, { timeoutMs: 12000 })
  const verified = verifySkillStoreManifest(manifest, { expectedSlug: slug })
  return {
    ...entry,
    repo: verified.repo,
    ref: verified.ref,
    path: verified.path,
    verified: true,
    artifactSha256: verified.artifactSha256,
    treeHash: verified.treeHash,
    signedAt: verified.signedAt,
    installName: entry.installName,
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
