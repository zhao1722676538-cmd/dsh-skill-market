/**
 * Install / uninstall / list skills.
 *
 * A skill is installed as one directory `<installRoot>/<name>/` containing the
 * SKILL.md subtree from a GitHub repository, plus a registry entry that records
 * where it came from and the hash of every file (so uninstall can detect local
 * edits instead of silently deleting them).
 *
 * @module dsh-skill-market/install/installer
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import {
  backupDir,
  hashDir,
  isInside,
  mutateRegistry,
  readRegistry,
  resolveInstallRoot,
  sha256,
  stagingDir,
  validateSkillName,
} from '../registry.js'
import { fetchRepoArchive, locateSkillDir, normalizeDeps, normalizeRepo, resolveCommit, resolveDefaultBranch } from './github.js'

const MAX_FILES = 400
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_TOTAL_BYTES = 40 * 1024 * 1024

/**
 * @param {import('../types.js').SkillEntry} entry
 * @param {{installRoot?: string, deps?: object, overwrite?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<{ok: true, name: string, dir: string, files: number, repo: string, ref: string,
 *   commit: string | null, path: string, source: string, updated: boolean, warnings: string[]}>}
 */
export async function installSkill(entry, opts = {}) {
  const deps = normalizeDeps(opts.deps)
  const root = resolveInstallRoot(opts.installRoot)
  const warnings = []

  const repo = normalizeRepo(entry?.repo)
  if (!repo) {
    throw new Error(
      `skill ${entry?.id ?? entry?.name ?? '?'} has no GitHub repository coordinate` +
        ' (the source only knows a site id); retry with repo="owner/name" path="<dir>" or pick a source that exposes one',
    )
  }
  const ref = typeof entry.ref === 'string' && entry.ref.trim() !== '' ? entry.ref.trim() : ''

  const archive = await fetchRepoArchive({ repo, ref: await pinRef(repo, ref, deps) }, deps)
  const located = locateSkillDir(archive.files, { hintPath: entry.path, name: entry.name })
  if (!located) throw new Error(`${repo}${ref ? `@${ref}` : ''} contains no SKILL.md`)
  if (located.ambiguous) {
    throw new Error(
      `${repo}${ref ? `@${ref}` : ''} has several SKILL.md candidates: ${located.ambiguous.join(', ')}. ` +
        'Re-run with a more specific path, e.g. path="<one of those directories>".',
    )
  }

  const skillDir = located.dir
  const prefix = skillDir === '' ? '' : `${skillDir}/`
  const files = selectFiles(archive.files, prefix, skillDir, warnings)
  if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
    throw new Error(`${repo}: located ${prefix}SKILL.md but could not include it in the payload`)
  }

  const manifest = parseFrontmatter(files.find((file) => file.path.toLowerCase() === 'skill.md').data.toString('utf8'))
  const rawName = manifest.name || entry.name || path.basename(prefix || repo)
  let name
  try {
    name = validateSkillName(rawName)
  } catch {
    name = validateSkillName(entry.name ?? path.basename(prefix || repo) ?? 'skill')
    warnings.push(`SKILL.md declared an invalid name ${JSON.stringify(rawName)}; falling back to ${name}`)
  }

  const target = path.join(root, name)
  if (!isInside(root, target)) throw new Error(`refusing to install outside ${root}: ${target}`)

  const { data: registry } = await readRegistry(root)
  const managed = registry.skills[name]
  const exists = await pathExists(target)
  if (exists && !managed && opts.overwrite !== true) {
    throw Object.assign(
      new Error(
        `${target} already exists but is not managed by this plugin (an existing skill with the same name). ` +
          'Pass overwrite=true to replace it, or pick another name.',
      ),
      { code: 'EEXIST_UNMANAGED' },
    )
  }

  if (opts.dryRun === true) {
    return {
      ok: true,
      name,
      dir: target,
      files: files.length,
      repo,
      ref: archive.ref ?? ref,
      commit: archive.commit ?? null,
      path: skillDir,
      source: entry.source,
      updated: Boolean(exists),
      warnings,
    }
  }

  await fs.mkdir(root, { recursive: true })
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const stage = path.join(stagingDir(root), token)
  const stagedSkill = path.join(stage, name)

  try {
    for (const file of files) {
      await writeSafe(stage, name, file.path, file.data)
    }
    const hashes = await hashDir(stagedSkill, { limitFiles: MAX_FILES, limitBytes: MAX_TOTAL_BYTES })

    let backup
    if (exists) {
      backup = path.join(backupDir(root), `${name}-${token}`)
      await fs.mkdir(path.dirname(backup), { recursive: true })
      await fs.rename(target, backup)
    }
    try {
      await fs.rename(stagedSkill, target)
    } catch (err) {
      if (backup) await fs.rename(backup, target).catch(() => {})
      throw err
    }

    const installedAt = new Date().toISOString()
    try {
      await mutateRegistry(root, (data) => {
        data.skills[name] = {
          source: entry.source,
          id: entry.id,
          repo,
          ref: archive.ref ?? ref,
          commit: archive.commit ?? null,
          path: skillDir,
          installedAt,
          files: hashes,
        }
      })
    } catch (err) {
      // 目录已经换成新版本、注册表却没写成功 → 下次卸载会把它当成「非本插件安装的」而不敢删。
      // 回滚：删掉新目录、把备份换回去、注册表恢复成旧记录。
      warnings.push(`registry update failed, restored the previous version: ${err?.message ?? err}`)
      await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      if (backup) await fs.rename(backup, target).catch(() => {})
      await mutateRegistry(root, (data) => {
        if (managed) data.skills[name] = managed
        else delete data.skills[name]
      }).catch(() => {})
      throw err
    }

    if (backup) {
      await fs.rm(backup, { recursive: true, force: true }).catch((err) => {
        warnings.push(`could not remove backup ${backup}: ${err?.message ?? err}`)
      })
    }

    return {
      ok: true,
      name,
      dir: target,
      files: hashes.length,
      repo,
      ref: archive.ref ?? ref,
      commit: archive.commit ?? null,
      path: skillDir,
      source: entry.source,
      updated: Boolean(exists),
      warnings,
    }
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Resolve a missing ref to a concrete commit, so the registry records exactly
 * what was installed (and a later reinstall of the same repo is comparable).
 * @param {string} repo
 * @param {string} ref
 * @param {ReturnType<typeof normalizeDeps>} deps
 */
async function pinRef(repo, ref, deps) {
  if (ref !== '') return ref
  const branch = await resolveDefaultBranch({ repo }, deps).catch(() => '')
  if (!branch) return 'HEAD'
  const sha = await resolveCommit(repo, branch, deps).catch(() => null)
  return sha ?? branch
}

/**
 * Pick the regular files that belong to one skill subtree.
 * @param {{path: string, type: string, size: number, data?: Buffer}[]} all
 * @param {string} prefix
 * @param {string} skillDir
 * @param {string[]} warnings
 */
function selectFiles(all, prefix, skillDir, warnings) {
  const picked = []
  let total = 0
  let skipped = 0
  for (const file of all) {
    if (file.type !== 'file' || !file.data) {
      if (file.type === 'other') skipped += 1
      continue
    }
    if (prefix !== '' && !file.path.startsWith(prefix)) continue
    if (prefix === '' && file.path.includes('../')) continue
    const rel = prefix === '' ? file.path : file.path.slice(prefix.length)
    if (!isSafeRelative(rel)) {
      warnings.push(`skipped unsafe archive path ${JSON.stringify(file.path)}`)
      continue
    }
    if (!isWindowsSafeRelative(rel)) {
      warnings.push(`skipped ${JSON.stringify(file.path)}: not a legal file name on Windows`)
      continue
    }
    if (file.data.length > MAX_FILE_BYTES) {
      warnings.push(`skipped ${rel}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`)
      continue
    }
    total += file.data.length
    if (total > MAX_TOTAL_BYTES) throw new Error(`skill payload exceeds ${MAX_TOTAL_BYTES / 1024 / 1024} MiB`)
    if (picked.length >= MAX_FILES) throw new Error(`skill payload exceeds ${MAX_FILES} files`)
    picked.push({ path: rel, data: file.data })
  }
  if (skipped > 0) warnings.push(`ignored ${skipped} non-regular archive entry/entries (symlinks, devices)`)
  if (skillDir === '') warnings.push('SKILL.md sits at the repository root, so the whole repository tree was installed')
  return picked
}

/** @param {string} rel */
function isSafeRelative(rel) {
  if (rel === '' || rel.startsWith('/') || rel.includes('\\') || /^[a-zA-Z]:/.test(rel)) return false
  return rel.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** Windows 保留设备名（带不带扩展名都不合法） */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 归档里的路径在 Windows 上必须能真的建成文件：`con.md`、`a:b.md`、
 * 以点或空格结尾的名字都会让 fs.writeFile 直接 EINVAL，让整个安装失败。
 * 这里提前挑出来跳过（带 warning），而不是装到一半崩掉。
 * @param {string} rel
 */
function isWindowsSafeRelative(rel) {
  return rel.split('/').every((segment) => {
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return false
    if (/[. ]$/.test(segment)) return false
    return !WINDOWS_RESERVED_NAME.test(segment)
  })
}

/**
 * Write one relative path under `<stage>/<name>/`, proving it stays there.
 * @param {string} stage
 * @param {string} name
 * @param {string} rel
 * @param {Buffer} data
 */
async function writeSafe(stage, name, rel, data) {
  const base = path.join(stage, name)
  const full = path.join(base, ...rel.split('/'))
  if (!isInside(base, full)) throw new Error(`refusing to write outside the staging directory: ${rel}`)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, data)
}

/**
 * @param {string} name
 * @param {{installRoot?: string, force?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, name: string, reason?: string, dir?: string, conflicts?: string[], removed?: string[]}>}
 */
export async function uninstallSkill(name, opts = {}) {
  const root = resolveInstallRoot(opts.installRoot)
  let clean
  try {
    clean = validateSkillName(name)
  } catch (err) {
    return { ok: false, name: String(name ?? ''), reason: 'unknown', dir: undefined }
  }

  const { data: registry } = await readRegistry(root)
  const record = registry.skills[clean]
  const dir = path.join(root, clean)

  if (!record) {
    if (await pathExists(dir)) return { ok: false, name: clean, reason: 'unmanaged', dir }
    return { ok: false, name: clean, reason: 'unknown' }
  }
  if (!isInside(root, dir)) return { ok: false, name: clean, reason: 'unsafe', dir }
  if (!(await pathExists(dir))) {
    await mutateRegistry(root, (data) => {
      delete data.skills[clean]
    })
    return { ok: false, name: clean, reason: 'missing', dir }
  }

  const current = await hashDir(dir, { limitFiles: MAX_FILES + 50, limitBytes: MAX_TOTAL_BYTES + 1024 }).catch(() => null)
  if (current && opts.force !== true) {
    const conflicts = diffFiles(record.files ?? [], current)
    if (conflicts.length > 0) return { ok: false, name: clean, reason: 'modified', dir, conflicts }
  }

  await fs.rm(dir, { recursive: true, force: true })
  await mutateRegistry(root, (data) => {
    delete data.skills[clean]
  })
  return { ok: true, name: clean, dir, removed: [dir] }
}

/**
 * @param {{installRoot?: string}} [opts]
 * @returns {Promise<{name: string, source?: string, repo?: string, commit?: string | null,
 *   installedAt?: string, present: boolean, dir: string, files: number}[]>}
 */
export async function listInstalled(opts = {}) {
  const root = resolveInstallRoot(opts.installRoot)
  const { data: registry } = await readRegistry(root)
  const out = []
  for (const [name, record] of Object.entries(registry.skills)) {
    const dir = path.join(root, name)
    out.push({
      name,
      source: record.source,
      repo: record.repo,
      commit: record.commit ?? null,
      installedAt: record.installedAt,
      present: await pathExists(dir),
      dir,
      files: Array.isArray(record.files) ? record.files.length : 0,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * @param {{path: string, sha256: string}[]} recorded
 * @param {{path: string, sha256: string}[]} current
 */
function diffFiles(recorded, current) {
  const byPath = new Map(current.map((file) => [file.path, file.sha256]))
  const conflicts = []
  for (const file of recorded) {
    const hash = byPath.get(file.path)
    if (hash === undefined) conflicts.push(`deleted: ${file.path}`)
    else if (hash !== file.sha256) conflicts.push(`changed: ${file.path}`)
    byPath.delete(file.path)
  }
  for (const extra of byPath.keys()) conflicts.push(`added: ${extra}`)
  return conflicts
}

/**
 * Minimal YAML frontmatter reader for the two fields a skill needs here.
 * @param {string} text
 * @returns {{name?: string, description?: string}}
 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? '').replace(/^\uFEFF/, ''))
  if (!match) return {}
  /** @type {{name?: string, description?: string}} */
  const out = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    const key = kv[1]
    if (key !== 'name' && key !== 'description') continue
    let value = kv[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value !== '') out[key] = value
  }
  return out
}

/** @param {string} target */
async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export default { installSkill, uninstallSkill, listInstalled, parseFrontmatter }
