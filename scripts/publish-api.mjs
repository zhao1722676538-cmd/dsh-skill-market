#!/usr/bin/env node
// Publish this working copy to GitHub through the REST API.
//
// Why: on this machine github.com's git transport is unreliable/blocked, while
// api.github.com works. This script needs no Git installation: it falls back to
// walking the filesystem when `git ls-files` is unavailable.
//
// Usage:
//   GITHUB_TOKEN=ghp_xxx node scripts/publish-api.mjs [--message "msg"] [--dry-run] [--with-workflows]
//
// Token: classic PAT with `repo` scope, 7 days is enough for a one-off push.
// Adding/changing `.github/workflows/*` also needs the `workflow` scope, otherwise
// the commit fails with "refusing to allow a Personal Access Token to create or
// update workflow ... without `workflow` scope" (403).
//
// So by default `.github/workflows/**` is NOT published from this script: those
// files belong in the GitHub web UI (Settings-free, no token scope needed), and
// the tree below is based on the current head tree, so they are left untouched.
// Pass --with-workflows only with a token that carries the workflow scope; the
// script preflights the token's scopes (x-oauth-scopes) and refuses early instead
// of dying halfway through the commit.
// The token is never printed and never written to disk by this script.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const getArg = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const DRY = args.includes('--dry-run')
const TOKEN = process.env.GITHUB_TOKEN
/** classic token 的 scope 列表（来自 x-oauth-scopes 响应头）；null = 未知（fine-grained token 不返回该头） */
let TOKEN_SCOPES = null
const root = process.cwd()

if (!TOKEN && !DRY) {
  console.error('GITHUB_TOKEN is required (classic token, scope: repo).')
  process.exit(2)
}

// owner/repo: explicit env vars win, otherwise the repository field in package.json
function resolveTarget() {
  if (process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    return { owner: process.env.GITHUB_OWNER, repo: process.env.GITHUB_REPO }
  }
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url || '')
  if (!m) throw new Error('Cannot derive owner/repo: set GITHUB_OWNER and GITHUB_REPO, or package.json repository')
  return { owner: m[1], repo: m[2] }
}
const { owner: OWNER, repo: REPO } = resolveTarget()

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.work', '.dsh', '.agents', 'dist', 'coverage', '.cache'])
const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db'])
const IGNORE_EXT = new Set(['.log'])

function listFilesWithGit() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return null
  }
}

function listFilesByWalking(dir = '.', out = []) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir === '.' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) listFilesByWalking(rel, out)
    } else if (entry.isFile()) {
      if (IGNORE_FILES.has(entry.name) || IGNORE_EXT.has(path.extname(entry.name))) continue
      out.push(rel)
    }
  }
  return out
}

const allFiles = listFilesWithGit() || listFilesByWalking()
if (!allFiles.length) throw new Error('no files to publish')

const WORKFLOW_PREFIX = '.github/workflows/'
const WITH_WORKFLOWS = args.includes('--with-workflows')
const workflowFiles = allFiles.filter((file) => file.startsWith(WORKFLOW_PREFIX))
const files = WITH_WORKFLOWS ? allFiles : allFiles.filter((file) => !file.startsWith(WORKFLOW_PREFIX))
if (workflowFiles.length && !WITH_WORKFLOWS) {
  console.log(
    `skipping ${workflowFiles.length} workflow file(s) (${workflowFiles.join(', ')}): ` +
      'commit them in the GitHub web UI, or re-run with --with-workflows and a token that has the workflow scope',
  )
}
console.log(`publishing ${files.length} files from ${root} -> ${OWNER}/${REPO}${DRY ? ' (dry run)' : ''}`)

const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-skill-market-publisher',
  'content-type': 'application/json',
}
const api = (p) => `https://api.github.com${p}`

async function call(method, p, body) {
  if (DRY) {
    console.log(`[dry] ${method} ${p}`)
    return { status: 200, json: { sha: 'dry-run-sha', default_branch: 'main', object: { sha: 'dry-run-sha' } } }
  }
  const res = await fetch(api(p), { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (TOKEN_SCOPES === null) {
    // classic PAT 会回这个头；fine-grained token 没有，那就只能等 403 再解释
    const reported = res.headers?.get?.('x-oauth-scopes')
    if (reported != null) {
      TOKEN_SCOPES = reported.split(',').map((scope) => scope.trim()).filter(Boolean)
      console.log(`token scopes: ${TOKEN_SCOPES.length ? TOKEN_SCOPES.join(', ') : '(none reported)'}`)
    }
  }
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 300) } }
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    throw new Error(`${method} ${p} -> ${res.status} ${json?.message || res.statusText}`)
  }
  return { status: res.status, json }
}

// 1. repository must exist
const repo = await call('GET', `/repos/${OWNER}/${REPO}`)
if (repo.status === 404) {
  await call('POST', '/user/repos', {
    name: REPO,
    homepage: `https://github.com/${OWNER}/${REPO}`,
    private: false,
    auto_init: false,
  })
  console.log('repository created')
} else {
  console.log(`repository exists (default_branch=${repo.json.default_branch})`)
}

// 2. an empty repository rejects the trees API (409): seed one commit first
const ref0 = await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
if (ref0.status === 404 || ref0.status === 409) {
  console.log('repository is empty -> seeding an initial commit')
  await call('PUT', `/repos/${OWNER}/${REPO}/contents/README.md`, {
    message: 'init',
    content: Buffer.from('# ' + REPO + '\n', 'utf8').toString('base64'),
  })
}
const parentSha = (await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)).json?.object?.sha ?? null
// 2b. build the new tree on top of the current head tree, so files that exist only
// on GitHub (.github/workflows/*, package-lock.json, ...) are kept instead of deleted
const parentTree = parentSha
  ? (await call('GET', `/repos/${OWNER}/${REPO}/git/commits/${parentSha}`)).json?.tree?.sha ?? null
  : null

// 3. one tree: UTF-8 text inline, anything else as a base64 blob
const tree = []
let blobs = 0
for (const file of files) {
  const abs = path.join(root, file)
  if (!statSync(abs).isFile()) continue
  const buf = readFileSync(abs)
  const text = buf.toString('utf8')
  if (!text.includes('\u0000') && Buffer.from(text, 'utf8').equals(buf)) {
    tree.push({ path: file, mode: '100644', type: 'blob', content: text })
  } else {
    const blob = await call('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' })
    tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.json.sha })
    blobs += 1
  }
}
if (blobs) console.log(`binary blobs: ${blobs}`)

// 3b. preflight: 改 .github/workflows/* 需要 workflow scope。等 commit 走到一半才 403
// 最糟糕（还得重试一遍），所以这里拿着响应头里的 scope 先判一次。
const workflowPaths = tree.map((entry) => entry.path).filter((p) => p.startsWith(WORKFLOW_PREFIX))
if (workflowPaths.length) {
  if (TOKEN_SCOPES && !TOKEN_SCOPES.includes('workflow')) {
    throw new Error(
      `this commit touches ${workflowPaths.length} workflow file(s) (${workflowPaths.join(', ')}) ` +
        `but the token only has [${TOKEN_SCOPES.join(', ')}]. Either drop --with-workflows and add them in the ` +
        'GitHub web UI, or mint a token with the workflow scope at https://github.com/settings/tokens',
    )
  }
  if (!TOKEN_SCOPES) {
    console.log('workflow files included, but this token does not report scopes; a 403 here means it lacks `workflow`')
  }
}
const treeRes = await call('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree, ...(parentTree ? { base_tree: parentTree } : {}) })
console.log(`tree ${String(treeRes.json.sha).slice(0, 10)} (${tree.length} entries${parentTree ? ', based on head' : ''})`)
if (parentTree) {
  const localPaths = new Set(tree.map((entry) => entry.path))
  const base = (await call('GET', `/repos/${OWNER}/${REPO}/git/trees/${parentTree}?recursive=1`)).json
  const kept = (base?.tree ?? []).filter((entry) => entry.type === 'blob' && !localPaths.has(entry.path))
  if (kept.length) console.log(`kept ${kept.length} remote-only file(s): ${kept.map((entry) => entry.path).join(', ')}`)
}

// 4. commit + move main
const commitRes = await call('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message: getArg('--message', 'chore: publish working copy'),
  tree: treeRes.json.sha,
  ...(parentSha ? { parents: [parentSha] } : {}),
})
const sha = commitRes.json.sha
const existing = await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
if (existing.status === 404 || existing.status === 409) {
  await call('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: 'refs/heads/main', sha })
} else {
  await call('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha, force: false })
}

// 5. verify the result anonymously
if (!DRY) {
  const base = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main`
  for (const f of ['package.json', 'README.md']) {
    const res = await fetch(`${base}/${f}`)
    console.log(`verify ${f}: ${res.status}`)
  }
}

console.log(`\nrepo:    https://github.com/${OWNER}/${REPO}`)
console.log(`commit:  ${sha}`)
