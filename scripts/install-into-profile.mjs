#!/usr/bin/env node
/**
 * Install this plugin into a DeepSeek Harness profile.
 *
 * The profile owns the bundle list (`dsh.profile.bundles` in its package.json);
 * a bundle is resolved from `<profile>/node_modules/<name>`, so installing means:
 *   1. copy the plugin package into that node_modules directory,
 *   2. append its package name to the profile's bundle list,
 *   3. restart the app (the GUI loads host and client halves at boot).
 *
 * Usage:
 *   node scripts/install-into-profile.mjs                 # install into "desktop"
 *   node scripts/install-into-profile.mjs --profile web
 *   node scripts/install-into-profile.mjs --dry-run       # print the plan only
 *   node scripts/install-into-profile.mjs --uninstall     # remove it again
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-skill-market'
const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PACKAGE_FILES = ['package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'src', 'client', 'locale', 'scripts']

function parseArgs(argv) {
  const out = { profile: 'desktop', dryRun: false, uninstall: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--dry-run' || arg === '-n') out.dryRun = true
    else if (arg === '--uninstall') out.uninstall = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return out
}

function dshHome() {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
}

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function copyPackage(dest) {
  for (const entry of PACKAGE_FILES) {
    const from = path.join(HERE, entry)
    if (!(await exists(from))) continue
    await fs.cp(from, path.join(dest, entry), { recursive: true })
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, file)
}

function transactionToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node scripts/install-into-profile.mjs [--profile <name>] [--dry-run] [--uninstall]')
    return
  }
  const profileDir = path.join(dshHome(), 'profiles', args.profile)
  const manifestPath = path.join(profileDir, 'package.json')
  if (!(await exists(manifestPath))) {
    throw new Error(`no profile at ${profileDir} (is DSH_HOME correct?)`)
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const target = path.join(profileDir, 'node_modules', PLUGIN_NAME)
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const listed = bundles.includes(PLUGIN_NAME)
  const installed = await exists(path.join(target, 'package.json'))

  console.log(`profile:  ${profileDir}`)
  console.log(`plugin:   ${PLUGIN_NAME}`)
  console.log(`target:   ${target}`)
  console.log(`state:    ${installed ? 'files present' : 'not installed'}, ${listed ? 'listed in bundles' : 'not in bundles'}`)

  if (args.uninstall) {
    if (args.dryRun) {
      console.log('dry-run: would remove plugin files and its bundle-list entry')
      return
    }
    const next = bundles.filter((entry) => entry !== PLUGIN_NAME)
    const token = transactionToken()
    const backup = path.join(profileDir, 'node_modules', `.${PLUGIN_NAME}.uninstall-${token}`)
    const moved = await exists(target)
    if (moved) await fs.rename(target, backup)
    try {
      if (next.length !== bundles.length) {
        manifest.dsh.profile.bundles = next
        await writeJsonAtomic(manifestPath, manifest)
      }
    } catch (err) {
      if (moved) await fs.rename(backup, target).catch(() => {})
      throw err
    }
    if (moved) await fs.rm(backup, { recursive: true, force: true })
    console.log(`removed ${PLUGIN_NAME}; restart the app to unload it`)
    return
  }

  if (args.dryRun) {
    console.log('dry-run: would copy the package and append it to dsh.profile.bundles')
    return
  }

  const token = transactionToken()
  const nodeModules = path.dirname(target)
  const stage = path.join(nodeModules, `.${PLUGIN_NAME}.stage-${token}`)
  const backup = path.join(nodeModules, `.${PLUGIN_NAME}.backup-${token}`)
  let hadTarget = false
  let installedNew = false
  let keepBackup = false
  try {
    await fs.mkdir(nodeModules, { recursive: true })
    await fs.rm(stage, { recursive: true, force: true })
    await fs.mkdir(stage, { recursive: true })
    await copyPackage(stage)
    if (!(await exists(path.join(stage, 'package.json'))) || !(await exists(path.join(stage, 'src', 'index.js')))) {
      throw new Error('staged package is incomplete')
    }

    hadTarget = await exists(target)
    if (hadTarget) await fs.rename(target, backup)
    await fs.rename(stage, target)
    installedNew = true

    if (!listed) {
      manifest.dsh.profile.bundles = [...bundles, PLUGIN_NAME]
      await writeJsonAtomic(manifestPath, manifest)
      console.log('appended to dsh.profile.bundles')
    }
  } catch (err) {
    if (installedNew) await fs.rm(target, { recursive: true, force: true }).catch(() => {})
    if (hadTarget) {
      await fs.rename(backup, target).catch(() => {
        keepBackup = true
      })
    }
    if (keepBackup) {
      err.message += `; the previous version remains at ${backup} and must be restored manually`
    }
    throw err
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
    if (installedNew && !keepBackup) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
  }
  console.log(`\ninstalled → ${target}`)
  console.log('restart DeepSeek Harness to load the plugin (host tools + the "技能市场" tab).')
}

main().catch((error) => {
  console.error(`install failed: ${error?.message ?? error}`)
  process.exitCode = 1
})
