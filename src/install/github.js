/**
 * GitHub 侧取包 / 定位 skill 目录 —— 只用 node: 内置（SPEC §5.2）。
 *
 * 依赖注入约定（与 §2 SourceDeps 对齐，但全部可选）：
 *   deps.http(input, init) -> Promise<Response>   默认 = 全局 fetch + AbortSignal.timeout
 *   deps.tokens.github    -> string|undefined    可选，作为 Bearer
 *   deps.log(msg)         -> void                默认 no-op
 *
 * 不 import 任何 @deepseek-ai/*，可脱离 DSH 单跑。
 *
 * @module dsh-skill-market/install/github
 */

import { readTarGz } from './tar.js'

const DEFAULT_TIMEOUT_MS = 15000
const ARCHIVE_TIMEOUT_MS = 90000
const ARCHIVE_TTL_MS = 10 * 60 * 1000
/** 单个 tarball 的体积上限：超过就不下载/不解压，避免被超大仓库拖死 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
/** 缓存里最多留几个仓库（每个条目持有整包 Buffer，必须封顶） */
const ARCHIVE_CACHE_MAX_ENTRIES = 8
const USER_AGENT = 'dsh-skill-market/0.1 (+https://github.com/zhao1722676538-cmd/dsh-skill-market)'

/** 默认 HTTP：全局 fetch + 超时；调用方显式传 signal 时以 signal 为准 */
export function defaultHttp(input, init = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init || {}
  const signal = rest.signal || AbortSignal.timeout(timeoutMs)
  return fetch(input, { ...rest, signal })
}

/** 归一化依赖；缺省全部走安全默认值 */
export function normalizeDeps(deps = {}) {
  const d = deps || {}
  return {
    http: typeof d.http === 'function' ? d.http : defaultHttp,
    tokens: d.tokens && typeof d.tokens === 'object' ? d.tokens : {},
    log: typeof d.log === 'function' ? d.log : () => {},
  }
}

function ghError(code, message, cause) {
  const err = new Error(message)
  err.code = code
  if (cause) err.cause = cause
  return err
}

function apiHeaders(deps, extra = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
    ...extra,
  }
  const token = deps.tokens?.github
  // 注意：token 只进请求头，绝不进日志/清单（SPEC §0.5）
  if (typeof token === 'string' && token.trim()) headers.authorization = `Bearer ${token.trim()}`
  return headers
}

/** 校验 `owner/name` 形态的 repo 坐标 */
export function normalizeRepo(repo) {
  if (typeof repo !== 'string') return null
  const text = repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/.exec(text)
  if (!m) return null
  return `${m[1]}/${m[2]}`
}

/** 逐段编码 ref，保留 `/`（codeload 要 `tar.gz/feature/x` 这种真实路径） */
function encodeRef(ref) {
  return String(ref)
    .split('/')
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/** 从 `{repo}-{sha}` 顶层目录名提取 40/7+ 位 sha */
function shaFromTopDir(topDir) {
  const m = /-([0-9a-f]{7,40})$/i.exec(topDir || '')
  return m ? m[1].toLowerCase() : null
}

export function clearArchiveCache() {
  archiveCache.clear()
}

/** @type {Map<string, {at:number, promise:Promise<any>}>} 进程内 10 分钟缓存 */
const archiveCache = new Map()

/**
 * 惰性过期只看命中的那个 key，过期条目会一直躺着占内存。
 * 每次写入前扫一遍：先丢过期的，再按插入顺序丢最旧的，保证条目数有上限。
 */
function pruneArchiveCache() {
  const now = Date.now()
  for (const [key, value] of archiveCache) {
    if (now - value.at >= ARCHIVE_TTL_MS) archiveCache.delete(key)
  }
  while (archiveCache.size >= ARCHIVE_CACHE_MAX_ENTRIES) {
    const oldest = archiveCache.keys().next()
    if (oldest.done) break
    archiveCache.delete(oldest.value)
  }
}

/**
 * 下载并解析仓库 tarball。顶层目录（`{repo}-{sha}/`）会被剥掉，
 * 返回的 `files[].path` 都是**仓库相对路径**。
 *
 * @param {{repo:string, ref?:string}} spec
 * @param {object} [deps]
 * @returns {Promise<{files:object[], commit:string|null, repo:string, ref:string, topDir:string, archiveBytes:number, source:'archive'|'api'|'none'}>}
 */
export async function fetchRepoArchive({ repo, ref } = {}, deps) {
  const d = normalizeDeps(deps)
  const cleanRepo = normalizeRepo(repo)
  if (!cleanRepo) throw ghError('EINVALID_REPO', `invalid repo coordinate: ${JSON.stringify(repo)} (expect "owner/name")`)

  const refText = ref == null || ref === '' ? 'HEAD' : String(ref).trim()
  const cacheKey = `${cleanRepo}@${refText.toLowerCase()}`
  const cached = archiveCache.get(cacheKey)
  if (cached && Date.now() - cached.at < ARCHIVE_TTL_MS) {
    d.log(`[github] archive cache hit ${cacheKey}`)
    return cached.promise
  }

  const promise = downloadArchive(cleanRepo, refText, d)
  pruneArchiveCache()
  archiveCache.set(cacheKey, { at: Date.now(), promise })
  try {
    return await promise
  } catch (err) {
    archiveCache.delete(cacheKey)
    throw err
  }
}

async function downloadArchive(repo, refText, d) {
  const url = `https://codeload.github.com/${repo}/tar.gz/${encodeRef(refText)}`
  d.log(`[github] GET ${url}`)
  let res
  try {
    // A tarball download is a file transfer, not an API call: the marketplace
    // request timeout (15s) is far too short for a repo of a few megabytes.
    res = await d.http(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', timeoutMs: ARCHIVE_TIMEOUT_MS })
  } catch (cause) {
    throw ghError('ENETWORK', `failed to download ${repo}@${refText}: ${cause?.message || cause}`, cause)
  }
  if (!res || res.ok === false) {
    throw ghError(
      'EHTTP',
      `failed to download ${repo}@${refText}: HTTP ${res?.status ?? '?'} ${res?.statusText || ''}`.trim(),
    )
  }

  const declared = Number(res.headers?.get?.('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    throw ghError(
      'EARCHIVE_TOO_LARGE',
      `${repo}@${refText} is ${Math.round(declared / 1024 / 1024)} MiB, over the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB limit`,
    )
  }

  const arrayBuffer = await res.arrayBuffer()
  const buf = Buffer.from(arrayBuffer)
  if (buf.length > MAX_ARCHIVE_BYTES) {
    throw ghError(
      'EARCHIVE_TOO_LARGE',
      `${repo}@${refText} is ${Math.round(buf.length / 1024 / 1024)} MiB, over the ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB limit`,
    )
  }
  const entries = await readTarGz(buf)

  // 顶层目录名，例如 `skills-8f3c2a1d.../`
  const firstPath = entries.find((e) => e.path)?.path || ''
  const topDir = firstPath.split('/')[0] || ''
  if (!topDir) throw ghError('EINVALID_ARCHIVE', 'archive has no top-level directory')

  const stripped = []
  for (const entry of entries) {
    let relative
    if (entry.path === topDir) continue // 顶层目录自身
    if (entry.path.startsWith(`${topDir}/`)) relative = entry.path.slice(topDir.length + 1)
    else {
      // 极少数包不带统一顶层目录：保留原路径，交给 locateSkillDir 处理
      relative = entry.path
    }
    if (!relative) continue
    stripped.push({ ...entry, path: relative })
  }

  let commit = shaFromTopDir(topDir)
  let commitSource = commit ? 'archive' : 'none'
  if (!commit) {
    commit = await resolveCommit(repo, refText, d).catch(() => null)
    commitSource = commit ? 'api' : 'none'
  }

  return {
    files: stripped,
    commit,
    repo,
    ref: refText,
    topDir,
    archiveBytes: buf.length,
    commitSource,
  }
}

/** 通过 REST API 把 branch/tag 解析成 sha；匿名 60/h，失败返回 null（不致命） */
export async function resolveCommit(repo, ref, deps) {
  const d = normalizeDeps(deps)
  const cleanRepo = normalizeRepo(repo)
  if (!cleanRepo || !ref || ref === 'HEAD') return null
  const url = `https://api.github.com/repos/${cleanRepo}/commits/${encodeRef(ref)}`
  try {
    const res = await d.http(url, { headers: apiHeaders(d), timeoutMs: 8000 })
    if (!res.ok) {
      d.log(`[github] commits/${ref} -> HTTP ${res.status} (rate-limit remaining: ${res.headers?.get?.('x-ratelimit-remaining') ?? '?'})`)
      return null
    }
    const json = await res.json()
    const sha = json?.sha
    return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null
  } catch (err) {
    d.log(`[github] commits/${ref} failed: ${err?.message || err}`)
    return null
  }
}

/**
 * 解析默认分支；失败时回退 `HEAD`（codeload 直接认识 HEAD）。
 * @returns {Promise<string>}
 */
export async function resolveDefaultBranch({ repo } = {}, deps) {
  const d = normalizeDeps(deps)
  const cleanRepo = normalizeRepo(repo)
  if (!cleanRepo) throw ghError('EINVALID_REPO', `invalid repo coordinate: ${JSON.stringify(repo)}`)
  try {
    const res = await d.http(`https://api.github.com/repos/${cleanRepo}`, {
      headers: apiHeaders(d),
      timeoutMs: 8000,
    })
    if (res.ok) {
      const json = await res.json()
      if (typeof json?.default_branch === 'string' && json.default_branch) return json.default_branch
    }
    d.log(`[github] repos/${cleanRepo} -> HTTP ${res.status}; falling back to HEAD`)
  } catch (err) {
    d.log(`[github] repos/${cleanRepo} failed: ${err?.message || err}; falling back to HEAD`)
  }
  return 'HEAD'
}

/* ------------------------------------------------------------------ */
/* 目录定位                                                            */
/* ------------------------------------------------------------------ */

function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
}

/** 宽松比较：忽略大小写与所有非字母数字字符（`pdf-tools` ≈ `pdf_tools` ≈ `PDF Tools`） */
function looseKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function normalizeHintPath(hintPath) {
  if (hintPath == null) return null
  let text = String(hintPath).replace(/\\/g, '/').trim()
  if (!text) return ''
  text = text.replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  // 允许调用方直接把 `SKILL.md` 文件路径当 hint 传进来
  if (/(^|\/)SKILL\.md$/i.test(text)) text = text.replace(/\/?SKILL\.md$/i, '')
  return text
}

function dirOf(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function baseOf(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? path : path.slice(index + 1)
}

/**
 * 在仓库文件树里定位技能的根目录（包含 SKILL.md 的那个目录）。
 *
 * 优先级（SPEC §5.2，**绝不瞎猜**）：
 *   1. `<hintPath>/SKILL.md` 精确命中
 *   2. 目录末段 ≈ `name` 或 hint 末段
 *   3. 全仓只有一个 SKILL.md → 用它
 *   4. 多个 → 返回 `{ ambiguous: [...] }` 让调用方报错
 *
 * @param {{path:string, type:string}[]} files
 * @param {{hintPath?:string, name?:string}} [opts]
 * @returns {{dir:string, skillFile:string} | {ambiguous:string[]} | null}
 */
export function locateSkillDir(files, { hintPath, name } = {}) {
  if (!Array.isArray(files) || files.length === 0) return null

  const candidates = files
    .filter((f) => f && f.type !== 'dir' && /^skill\.md$/i.test(baseOf(String(f.path || ''))))
    .map((f) => dirOf(String(f.path)))
  // 去重 + 稳定排序
  const dirs = [...new Set(candidates)].sort()

  if (dirs.length === 0) return null

  const make = (dir) => ({ dir, skillFile: dir ? `${dir}/SKILL.md` : 'SKILL.md' })
  const hint = normalizeHintPath(hintPath)

  // 1) hint 精确命中（大小写不敏感）
  if (hint !== null) {
    const hit = dirs.find((dir) => dir.toLowerCase() === hint.toLowerCase())
    if (hit !== undefined) return make(hit)
  }

  // 2) 目录末段 ≈ name / hint 末段
  const wanted = []
  if (name) wanted.push(slugify(name))
  if (hint) wanted.push(slugify(baseOf(hint)))
  const keys = [...new Set(wanted.map(looseKey).filter((k) => k.length > 0))]
  if (keys.length > 0) {
    const matched = dirs.filter((dir) => {
      const key = looseKey(baseOf(dir))
      return key.length > 0 && keys.includes(key)
    })
    if (matched.length === 1) return make(matched[0])
    if (matched.length > 1) return { ambiguous: matched }
  }

  // 3) 唯一 SKILL.md
  if (dirs.length === 1) return make(dirs[0])

  // 4) 歧义
  return { ambiguous: dirs }
}

/* ------------------------------------------------------------------ */
/* 单文件读取（兜底：raw.githubusercontent → api contents）             */
/* ------------------------------------------------------------------ */

/**
 * @param {{repo:string, ref?:string, path:string}} spec
 * @param {object} [deps]
 * @returns {Promise<string>}
 */
export async function fetchSingleFile({ repo, ref, path: filePath } = {}, deps) {
  const d = normalizeDeps(deps)
  const cleanRepo = normalizeRepo(repo)
  if (!cleanRepo) throw ghError('EINVALID_REPO', `invalid repo coordinate: ${JSON.stringify(repo)}`)
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw ghError('EINVALID_PATH', 'fetchSingleFile() requires a non-empty path')
  }
  const cleanPath = filePath.replace(/^\/+/, '').replace(/\\/g, '/')
  const refText = ref == null || ref === '' ? 'HEAD' : String(ref).trim()

  const rawUrl = `https://raw.githubusercontent.com/${cleanRepo}/${encodeRef(refText)}/${cleanPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
  try {
    const res = await d.http(rawUrl, { headers: { 'user-agent': USER_AGENT } })
    if (res.ok) return await res.text()
    d.log(`[github] raw ${cleanPath} -> HTTP ${res.status}; trying api contents`)
  } catch (err) {
    d.log(`[github] raw ${cleanPath} failed: ${err?.message || err}; trying api contents`)
  }

  const apiUrl = `https://api.github.com/repos/${cleanRepo}/contents/${cleanPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?ref=${encodeURIComponent(refText)}`
  const res = await d.http(apiUrl, { headers: apiHeaders(d), timeoutMs: 10000 })
  if (!res.ok) {
    throw ghError('EHTTP', `failed to read ${cleanRepo}/${cleanPath}@${refText}: HTTP ${res.status}`)
  }
  const json = await res.json()
  if (typeof json?.content === 'string') {
    return Buffer.from(json.content, json.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
  }
  if (Array.isArray(json)) throw ghError('EIS_DIR', `${cleanPath} is a directory, not a file`)
  throw ghError('EUNEXPECTED_JSON', `unexpected GitHub contents response for ${cleanPath}`)
}

export default {
  fetchRepoArchive,
  resolveDefaultBranch,
  resolveCommit,
  locateSkillDir,
  fetchSingleFile,
  normalizeDeps,
  normalizeRepo,
  defaultHttp,
  clearArchiveCache,
}
