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
const CLI = path.join(ROOT, 'src', 'cli.js')

async function runCli(args) {
  try {
    const result = await execFileAsync(process.execPath, [CLI, ...args], { cwd: ROOT })
    return { ...result, code: 0 }
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      code: error.code ?? 1,
    }
  }
}

test('CLI searches a local index offline and never falls back to network', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cli-index-'))
  const index = path.join(dir, 'skill-index.json')
  try {
    await fs.writeFile(
      index,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        skills: [
          { name: 'pdf', source: 'github', repo: 'acme/pdf', path: 'skills/pdf', installs: 10 },
          { name: 'spreadsheet', source: 'skillssh', repo: 'acme/sheets' },
        ],
      }),
      'utf8',
    )
    const result = await runCli(['search', 'pdf', '--index', index, '--offline', '--json'])
    assert.equal(result.code, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.mode, 'index')
    assert.equal(payload.items.length, 1)
    assert.equal(payload.items[0].repo, 'acme/pdf')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('CLI rejects offline mode when no index is configured', async () => {
  const result = await runCli(['search', 'pdf', '--offline', '--json'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /--offline requires at least one --index/)
})
