import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function runInstaller(home, args = []) {
  return execFileAsync(process.execPath, [path.join(ROOT, 'scripts', 'install-into-profile.mjs'), ...args], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: home },
  })
}

test('DSH profile install and uninstall are repeatable and keep the bundle list consistent', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-profile-install-'))
  const profile = path.join(home, 'profiles', 'desktop')
  const manifestPath = path.join(profile, 'package.json')
  const target = path.join(profile, 'node_modules', 'dsh-skill-market')
  try {
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ private: true, dsh: { profile: { bundles: ['existing-bundle'] } } }, null, 2),
      'utf8',
    )

    await runInstaller(home, ['--dry-run'])
    await assert.rejects(fs.access(target))
    let manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['existing-bundle'])

    await runInstaller(home)
    await runInstaller(home)
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['existing-bundle', 'dsh-skill-market'])
    assert.ok(await fs.readFile(path.join(target, 'src', 'index.js'), 'utf8'))

    await runInstaller(home, ['--uninstall'])
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['existing-bundle'])
    await assert.rejects(fs.access(target))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
