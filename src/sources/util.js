/**
 * Small shared helpers for skill sources. Node builtins only.
 * @module dsh-skill-market/sources/util
 */

/**
 * Parse a GitHub URL into install coordinates.
 * Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<ref>/<path...>
 *   git@github.com:owner/repo(.git)
 * @param {string} [raw]
 * @returns {{repo:string, ref?:string, path?:string} | null}
 */
export function parseGitHubUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  const text = raw.trim().replace(/\.git$/, '')
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\/(?:tree|blob)\/([^/]+)\/(.*))?$/.exec(text)
  if (ssh) return coords(ssh)
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (parts.length < 2) return null
  const [, , mode, ref, ...rest] = parts
  if (mode !== 'tree' && mode !== 'blob') return { repo: `${parts[0]}/${parts[1]}` }
  return coords([null, parts[0], parts[1], ref, rest.join('/')])
}

/** @param {Array<string|null|undefined>} match */
function coords(match) {
  const repo = `${match[1]}/${match[2]}`
  const path = (match[4] || '').replace(/\/+$/, '')
  return { repo, ref: match[3] || undefined, path: path || undefined }
}

/**
 * Parse `owner/repo` shorthand, or a full GitHub URL, into `owner/repo`.
 * @param {string} [raw]
 * @returns {string | undefined}
 */
export function repoOf(raw) {
  if (!raw) return undefined
  const parsed = parseGitHubUrl(raw)
  if (parsed) return parsed.repo
  return /^[\w.-]+\/[\w.-]+$/.test(raw.trim()) ? raw.trim() : undefined
}

/** @param {string} text */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** @param {...unknown} values */
export function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** @param {...unknown} values */
export function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return undefined
}

/**
 * Keep at most `limit` entries and page a 1-based `page` over an offset API.
 * @param {{limit?: number, page?: number}} query
 * @param {number} fallbackLimit
 */
export function pageWindow(query, fallbackLimit = 10) {
  const limit = clamp(Math.trunc(Number(query.limit) || fallbackLimit), 1, 50)
  const page = Math.max(1, Math.trunc(Number(query.page) || 1))
  return { limit, page, offset: (page - 1) * limit }
}

/** @param {number} n @param {number} min @param {number} max */
export function clamp(n, min, max) {
  const value = Number(n)
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * A readable error for a missing query.
 * @param {string} source
 */
export function missingQueryError(source) {
  return new Error(`${source}: search query must not be empty`)
}
