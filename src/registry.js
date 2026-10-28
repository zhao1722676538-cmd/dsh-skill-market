/**
 * Install registry and path helpers. Nothing here reads a global singleton:
 * every function takes an explicit `installRoot`, so tests can use a temp dir.
 *
 * Registry layout (`<installRoot>/.skill-market/registry.json`):
 *   { version: 1, skills: { [name]: { source, id, repo, ref, commit, path,
 *                                     installedAt, files: [{path, sha256, size}] } } }
 *
 * @module dsh-skill-market/registry
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** @param {string} [explicit] */
export function resolveInstallRoot(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit.trim())
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'skills')
}

/** @param {string} installRoot */
export function registryPath(installRoot) {
  return path.join(installRoot, '.skill-market', 'registry.json')
}

/** @param {string} installRoot */
export function backupDir(installRoot) {
  return path.join(installRoot, '.skill-market', 'backup')
}

/** @param {string} installRoot */
export function stagingDir(installRoot) {
  return path.join(installRoot, '.staging')
}

/**
 * Read the registry, tolerating a missing or corrupt file (a corrupt registry is
 * reported through `warnings` instead of breaking installation forever).
 * @param {string} installRoot
 * @returns {Promise<{data: {version: number, skills: Record<string, any>}, warnings: string[]}>}
 */
export async function readRegistry(installRoot) {
  const file = registryPath(installRoot)
  const warnings = []
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { data: { version: 1, skills: {} }, warnings }
    throw err
  }
  try {
    const parsed = JSON.parse(text)
    const skills = parsed && typeof parsed.skills === 'object' && parsed.skills !== null ? parsed.skills : {}
    return { data: { version: 1, skills }, warnings }
  } catch (err) {
    warnings.push(`registry at ${file} is corrupt and was ignored: ${err?.message ?? err}`)
    return { data: { version: 1, skills: {} }, warnings }
  }
}

/**
 * Write the registry atomically (tmp file + rename in the same directory).
 * @param {string} installRoot
 * @param {{version: number, skills: Record<string, any>}} data
 */
export async function writeRegistry(installRoot, data) {
  const file = registryPath(installRoot)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

/** Serialize read-modify-write cycles per install root. */
const locks = new Map()

/**
 * @template T
 * @param {string} installRoot
 * @param {(data: {version: number, skills: Record<string, any>}) => Promise<T> | T} mutate
 * @returns {Promise<T>}
 */
export async function mutateRegistry(installRoot, mutate) {
  const key = path.resolve(installRoot)
  const previous = locks.get(key) ?? Promise.resolve()
  /** @type {Promise<unknown>} */
  const run = previous.catch(() => {}).then(async () => {
    const { data } = await readRegistry(key)
    const result = await mutate(data)
    await writeRegistry(key, data)
    return result
  })
  locks.set(key, run.catch(() => {}))
  return run
}

/** @param {Buffer|string} input */
export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

/**
 * Hash every regular file under `dir`, path-sorted, so two installs can be compared.
 * @param {string} dir
 * @param {{limitFiles?: number, limitBytes?: number}} [limits]
 * @returns {Promise<{path: string, sha256: string, size: number}[]>}
 */
export async function hashDir(dir, limits = {}) {
  const maxFiles = limits.limitFiles ?? 400
  const maxBytes = limits.limitBytes ?? 40 * 1024 * 1024
  /** @type {{path: string, sha256: string, size: number}[]} */
  const out = []
  let bytes = 0

  /** @param {string} current @param {string} prefix */
  async function walk(current, prefix) {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, rel)
        continue
      }
      if (!entry.isFile()) continue // symlinks and friends are never part of a skill
      if (out.length >= maxFiles) throw new Error(`skill has more than ${maxFiles} files`)
      const buffer = await fs.readFile(full)
      bytes += buffer.length
      if (bytes > maxBytes) throw new Error(`skill is larger than ${Math.round(maxBytes / 1024 / 1024)} MiB`)
      out.push({ path: rel, sha256: sha256(buffer), size: buffer.length })
    }
  }

  await walk(dir, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Normalize a skill directory name. Anything that could escape the install root
 * (slashes, dots-only names, uppercase) is rejected rather than rewritten.
 * @param {string} name
 * @returns {string}
 */
export function validateSkillName(name) {
  const raw = String(name ?? '').trim()
  if (raw === '') throw new Error('skill name must not be empty')
  if (raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\')) {
    throw new Error(`invalid skill name ${JSON.stringify(raw)}: path separators are not allowed`)
  }
  const normalized = raw.toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized)) {
    throw new Error(
      `invalid skill name ${JSON.stringify(raw)}: expected ^[a-z0-9][a-z0-9._-]{0,63}$ (lowercase letters, digits, dot, dash, underscore)`,
    )
  }
  return normalized
}

/**
 * True when `child` is a strict descendant of `parent` (both resolved).
 * @param {string} parent
 * @param {string} child
 */
export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
