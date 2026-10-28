/**
 * Plugin-market index generation (format 1).
 *
 * DSH's official plugin market reads a JSON index validated by
 * `@deepseek-ai/dsh-plugin-market-index`. This module produces a document that
 * passes that validator, so this plugin can be distributed the same way the
 * official market distributes plugins: publish the JSON, add its URL to
 * `indexes`, and the Discover tab offers a one-click install.
 *
 * Only documented fields are emitted; anything extra is dropped by the official
 * validator, so we do not invent fields.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** npm package-name grammar (same shape the official validator accepts). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const PACKAGE_NAME_MAX_LENGTH = 214
/** A pinned git commit: exactly 40 lowercase hex digits. */
const COMMIT = /^[0-9a-f]{40}$/u
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/u
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
/** SemVer 2.0.0, one exact version. */
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  'u',
)
/** Unix seconds; the official validator rejects values outside [0, 1e11). */
const MAX_PUBLISH_TIMESTAMP = 1e11
const MAX_INLINE_ICON_BYTES = 32 * 1024
const DATA_ICON = /^data:(?:image\/svg\+xml|image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/u
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/**
 * A light SemVer *range* check: the official validator calls `semver.validRange`.
 * We only need to reject the obvious mistakes at generation time; the real
 * validator still runs on the user's machine when the index is read.
 * @param {string} range
 * @returns {boolean}
 */
export function looksLikeSemverRange(range) {
  const text = range.trim()
  if (text === '' || text.startsWith('workspace:')) return false
  // ^1.2.3, ~1.2.3, >=1.2.3 <2.0.0, 1.x, 1.2.3 - 2.3.4, *, latest
  return /^(?:\*|latest|x)$/iu.test(text) || /\d/.test(text)
}

/**
 * @param {unknown} value
 * @param {string} at
 * @returns {Record<string, unknown>}
 */
function objectAt(value, at) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${at} must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/** @param {unknown} value @param {string} at */
function textAt(value, at) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${at} must be a non-empty string`)
  }
  return value
}

/**
 * Normalize localized text: a string, or `{ en: '...', zh: '...' }`.
 * The official validator requires `en`.
 * @param {string | Record<string, string>} value
 * @param {string} at
 * @returns {string | Record<string, string>}
 */
function localized(value, at) {
  if (typeof value === 'string') return textAt(value, at)
  const object = objectAt(value, at)
  const result = {}
  for (const [language, member] of Object.entries(object)) {
    if (!LANGUAGE_ID.test(language)) throw new Error(`${at}.${language} must be a lowercase language id`)
    result[language] = textAt(member, `${at}.${language}`)
  }
  if (!Object.hasOwn(result, 'en')) throw new Error(`${at} must contain en`)
  return result
}

/**
 * @param {string} text
 * @param {string} at
 * @returns {string}
 */
function gitUrl(text, at) {
  let url
  try {
    url = new URL(textAt(text, at))
  } catch {
    throw new Error(`${at} must be an absolute URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${at} must use https:`)
  if (url.href !== text) throw new Error(`${at} must be a canonical URL (no trailing slash changes)`)
  if (!/^(?:\/[^/]+){2,}$/u.test(url.pathname)) throw new Error(`${at} must name a repository (owner/name)`)
  if (/\.(?:tgz|tar\.gz)$/iu.test(url.pathname)) throw new Error(`${at} must name a repository, not a tarball`)
  return url.href
}

/**
 * Validate a relative package directory such as `packages/dsh-skill-market`.
 * @param {string} text
 * @param {string} at
 * @returns {string}
 */
function packagePath(text, at) {
  const value = textAt(text, at)
  const segments = value.split('/')
  if (segments.some((segment) => segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    throw new Error(`${at} must be a relative directory without . or .. segments`)
  }
  return value
}

/**
 * Build a format-1 plugin index document for this plugin.
 *
 * @param {object} options
 * @param {string} options.name npm package name (from package.json)
 * @param {string} options.version exact SemVer version (from package.json)
 * @param {string | Record<string, string>} [options.title] defaults to the package name
 * @param {string | Record<string, string>} [options.description]
 * @param {string} [options.author]
 * @param {string} [options.homepage]
 * @param {{url: string, directory?: string}} [options.repository]
 * @param {string} [options.icon] `data:` URL or https URL
 * @param {string[]} [options.keywords]
 * @param {{type: 'git', url: string, commit: string, path?: string} | {type: 'npm', registry?: string}} options.source
 * @param {string} [options.enginesDsh] SemVer range for `engines.dsh`
 * @param {number} [options.publishTimestamp] Unix seconds
 * @param {string | Record<string, string>} [options.indexTitle] index title (defaults to the plugin title)
 * @param {string | Record<string, string>} [options.indexDescription]
 * @returns {Record<string, unknown>} the index document, ready to serialize
 */
export function pluginIndexDocument(options) {
  const { name, version } = options
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) {
    throw new Error(`$.plugins[0].name must be a valid npm package name: ${JSON.stringify(name)}`)
  }
  if (!SEMVER.test(version)) {
    throw new Error(`$.plugins[0].versions[0].version must be an exact SemVer version: ${JSON.stringify(version)}`)
  }

  const publishTimestamp = options.publishTimestamp ?? Math.floor(Date.now() / 1000)
  if (!Number.isInteger(publishTimestamp) || publishTimestamp < 0 || publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
    throw new Error('publishTimestamp must be an integer number of Unix seconds in [0, 10^11)')
  }

  const source = objectAt(options.source, '$.plugins[0].versions[0].source')
  /** @type {Record<string, unknown>} */
  let normalizedSource
  if (source.type === 'git') {
    normalizedSource = {
      type: 'git',
      url: gitUrl(String(source.url), '$.plugins[0].versions[0].source.url'),
      commit: textAt(String(source.commit), '$.plugins[0].versions[0].source.commit'),
    }
    if (!COMMIT.test(String(normalizedSource.commit))) {
      throw new Error('$.plugins[0].versions[0].source.commit must be a lowercase 40-hex-digit commit SHA')
    }
    if (source.path !== undefined) {
      normalizedSource.path = packagePath(String(source.path), '$.plugins[0].versions[0].source.path')
    }
  } else if (source.type === 'npm') {
    normalizedSource = { type: 'npm' }
    if (source.registry !== undefined) {
      const registry = new URL(textAt(String(source.registry), '$.plugins[0].versions[0].source.registry'))
      if (registry.protocol !== 'https:' && registry.protocol !== 'http:') {
        throw new Error('$.plugins[0].versions[0].source.registry must use https: or http:')
      }
      normalizedSource.registry = registry.href
    }
  } else {
    throw new Error('$.plugins[0].versions[0].source.type must be "npm" or "git"')
  }

  const enginesDsh = options.enginesDsh
  if (enginesDsh !== undefined && !looksLikeSemverRange(enginesDsh)) {
    throw new Error(`engines.dsh must be a SemVer range: ${JSON.stringify(enginesDsh)}`)
  }

  const versionEntry = {
    version,
    publishTimestamp,
    source: normalizedSource,
    ...(enginesDsh === undefined ? {} : { engines: { dsh: enginesDsh } }),
  }

  const title = localized(options.title ?? name, '$.plugins[0].title')
  const plugin = {
    name,
    title,
    ...(options.description === undefined
      ? {}
      : { description: localized(options.description, '$.plugins[0].description') }),
    ...(options.icon === undefined ? {} : { icon: iconUrl(options.icon, '$.plugins[0].icon') }),
    ...(options.author === undefined ? {} : { author: textAt(options.author, '$.plugins[0].author') }),
    ...(options.homepage === undefined ? {} : { homepage: homepageUrl(options.homepage, '$.plugins[0].homepage') }),
    ...(options.repository === undefined ? {} : { repository: repository(options.repository) }),
    metadata: { keywords: keywords(options.keywords) },
    versions: [versionEntry],
  }

  return {
    format: 1,
    title: localized(options.indexTitle ?? title, '$.title'),
    ...(options.indexDescription === undefined
      ? {}
      : { description: localized(options.indexDescription, '$.description') }),
    metadata: {},
    plugins: [plugin],
  }
}

/** @param {string[]} [values] @returns {string[]} */
function keywords(values) {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new Error('$.plugins[0].metadata.keywords must be an array')
  return values.map((value, index) => textAt(String(value), `$.plugins[0].metadata.keywords[${index}]`))
}

/**
 * An absolute https URL, or an inline `data:` icon within the size limit.
 * @param {string} value
 * @param {string} at
 * @returns {string}
 */
function iconUrl(value, at) {
  if (value.startsWith('data:')) {
    const payload = DATA_ICON.exec(value)?.[1]
    if (payload === undefined || payload === '') {
      throw new Error(`${at} must be a base64 SVG, PNG, JPEG, or WebP data URL`)
    }
    if (!BASE64.test(payload)) throw new Error(`${at} must be valid base64`)
    const decoded = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)
    if (decoded > MAX_INLINE_ICON_BYTES) {
      throw new Error(`${at} must not exceed ${MAX_INLINE_ICON_BYTES / 1024} KiB of decoded bytes`)
    }
    return value
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${at} must be an absolute URL or a data: URL`)
  }
  if (url.protocol !== 'https:') throw new Error(`${at} must use https:`)
  return url.href
}

/** @param {string} value @returns {string} */
function homepageUrl(value) {
  const url = new URL(textAt(value, '$.plugins[0].homepage'))
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('$.plugins[0].homepage must use https: or http:')
  }
  return url.href
}

/**
 * @param {{url: string, directory?: string}} value
 * @returns {{url: string, directory?: string}}
 */
function repository(value) {
  const object = objectAt(value, '$.plugins[0].repository')
  const url = textAt(String(object.url), '$.plugins[0].repository.url')
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('$.plugins[0].repository.url must use https: or http:')
  }
  const directory = object.directory === undefined ? undefined : packagePath(String(object.directory), '$.plugins[0].repository.directory')
  return { url: parsed.href, ...(directory === undefined ? {} : { directory }) }
}

/** @param {Record<string, unknown>} document @returns {string} */
export function serializePluginIndex(document) {
  return `${JSON.stringify(document, undefined, 2)}\n`
}

/**
 * Run a git command and return trimmed stdout, or `undefined` when git is absent.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string | undefined}
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/**
 * Discover repository URL, HEAD commit and commit time from a git checkout.
 * @param {string} cwd
 * @returns {{url?: string, commit?: string, timestamp?: number}}
 */
export function detectGit(cwd) {
  const commit = git(['rev-parse', 'HEAD'], cwd)
  const url = git(['config', '--get', 'remote.origin.url'], cwd)
  const timestampText = commit === undefined ? undefined : git(['show', '-s', '--format=%ct', commit], cwd)
  return {
    ...(url === undefined ? {} : { url: normalizeRemoteUrl(url) }),
    ...(commit === undefined ? {} : { commit }),
    ...(timestampText === undefined ? {} : { timestamp: Number(timestampText) }),
  }
}

/**
 * Turn `git@github.com:o/r.git`, `https://github.com/o/r.git`, `ssh://…` into a canonical https URL.
 * @param {string} value
 * @returns {string | undefined}
 */
export function normalizeRemoteUrl(value) {
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(value)
  let url
  try {
    url = new URL(value)
  } catch {
    if (scp === null) return undefined
    url = new URL(`https://${scp[1]}/${scp[2]}`)
  }
  if (url.protocol === 'git+ssh:' || url.protocol === 'ssh:') {
    url = new URL(`https://${url.host}${url.pathname}`)
  }
  if (url.protocol !== 'https:') return undefined
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.href.endsWith('.git') ? url.href : `${url.href.replace(/\/$/u, '')}.git`
}

/**
 * Read `package.json` from a directory.
 * @param {string} cwd
 * @returns {Record<string, unknown>}
 */
export function readPackage(cwd) {
  const file = path.join(cwd, 'package.json')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * Build a plugin index for the package in `cwd`, filling repository/commit/version
 * metadata from git and `package.json` unless explicitly overridden.
 *
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {'git' | 'npm'} [options.sourceType] default `git`
 * @param {string} [options.repo]
 * @param {string} [options.commit]
 * @param {string} [options.path] package directory inside the repo
 * @param {number} [options.publishTimestamp]
 * @param {string[]} [options.keywords]
 * @param {string | Record<string, string>} [options.title]
 * @param {string | Record<string, string>} [options.description]
 * @param {string} [options.author]
 * @param {string} [options.homepage]
 * @param {string} [options.icon]
 * @param {string} [options.indexTitle]
 * @param {string} [options.indexDescription]
 * @returns {{document: Record<string, unknown>, warnings: string[]}}
 */
export function buildPluginIndex(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const pkg = readPackage(cwd)
  const gitInfo = detectGit(cwd)
  const warnings = []

  const name = textAt(String(pkg.name ?? ''), 'package.json name')
  const version = textAt(String(pkg.version ?? ''), 'package.json version')
  const repoUrl =
    options.repo ?? (pkg.repository !== undefined ? repositoryUrlOf(pkg.repository) : undefined) ?? gitInfo.url
  const commit = options.commit ?? gitInfo.commit

  if (options.sourceType === 'npm') {
    // nothing else needed: npm resolves name@version
  } else if (repoUrl === undefined) {
    throw new Error('cannot find a repository URL: run inside a git checkout with a remote, or pass --repo <https URL>')
  } else if (commit === undefined) {
    throw new Error('cannot find a git commit: run inside a git checkout, or pass --commit <40-hex sha>')
  }

  const engines = objectAt(pkg.engines ?? {}, 'package.json engines')
  const keywords = options.keywords ?? (Array.isArray(pkg.keywords) ? /** @type {string[]} */ (pkg.keywords) : [])
  if (options.keywords === undefined && keywords.length === 0) {
    warnings.push('no keywords in package.json and none passed: the market entry will have no keywords')
  }

  const document = pluginIndexDocument({
    name,
    version,
    title: options.title ?? pkg.displayName ?? name,
    description: options.description ?? pkg.description,
    author: options.author ?? authorOf(pkg.author),
    homepage: options.homepage ?? (typeof pkg.homepage === 'string' ? pkg.homepage : undefined),
    repository:
      options.sourceType === 'npm' || repoUrl === undefined
        ? undefined
        : {
            url: repoUrl.endsWith('.git') ? repoUrl.slice(0, -4) : repoUrl,
            ...(options.path === undefined ? {} : { directory: options.path }),
          },
    icon: options.icon,
    keywords,
    source:
      options.sourceType === 'npm'
        ? { type: 'npm' }
        : { type: 'git', url: String(repoUrl), commit: String(commit), ...(options.path === undefined ? {} : { path: options.path }) },
    enginesDsh: typeof engines.dsh === 'string' ? engines.dsh : undefined,
    publishTimestamp: options.publishTimestamp ?? gitInfo.timestamp,
    indexTitle: options.indexTitle,
    indexDescription: options.indexDescription,
  })

  if (engines.dsh === undefined) {
    warnings.push('package.json has no engines.dsh: the market will not show a DSH compatibility range')
  }

  return { document, warnings }
}

/** @param {unknown} value @returns {string | undefined} */
function repositoryUrlOf(value) {
  if (typeof value === 'string') return normalizeRemoteUrl(value)
  if (typeof value === 'object' && value !== null) {
    const url = /** @type {Record<string, unknown>} */ (value).url
    if (typeof url === 'string') return normalizeRemoteUrl(url)
  }
  return undefined
}

/** @param {unknown} value @returns {string | undefined} */
function authorOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const name = /** @type {Record<string, unknown>} */ (value).name
    if (typeof name === 'string') return name
  }
  return undefined
}

export default {
  buildPluginIndex,
  detectGit,
  normalizeRemoteUrl,
  pluginIndexDocument,
  readPackage,
  serializePluginIndex,
}
