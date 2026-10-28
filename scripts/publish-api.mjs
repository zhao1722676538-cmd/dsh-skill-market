#!/usr/bin/env node
// Publish the current git tree to GitHub through the REST API.
// Needed because this machine cannot reach github.com over HTTPS (git push resets),
// while api.github.com is reachable. Zero dependencies. Token comes from GITHUB_TOKEN.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const OWNER = 'zhao1722676538-cmd'
const REPO = 'dsh-skill-market'
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN) throw new Error('GITHUB_TOKEN is required')

const root = process.cwd()
const api = (p) => `https://api.github.com${p}`
const headers = {
  authorization: `Bearer ${TOKEN}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-skill-market-publisher',
  'content-type': 'application/json',
}

async function call(method, p, body) {
  const res = await fetch(api(p), { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 300) } }
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    const msg = json?.message || res.statusText
    throw new Error(`${method} ${p} -> ${res.status} ${msg}`)
  }
  return { status: res.status, json }
}

const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)

console.log(`local files to publish: ${files.length}`)

// 1. make sure the repository exists
let repo = await call('GET', `/repos/${OWNER}/${REPO}`)
if (repo.status === 404) {
  console.log('repository missing -> creating')
  const created = await call('POST', '/user/repos', {
    name: REPO,
    description: 'Skill marketplace for DeepSeek Harness: search skillsmp / skillstore / skills.sh / GitHub, install and uninstall skills.',
    homepage: `https://github.com/${OWNER}/${REPO}`,
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false,
  })
  repo = created
} else {
  console.log(`repository exists (default_branch=${repo.json.default_branch})`)
}

// 2. an empty repository rejects the trees API (409) — seed it with one commit first
let parentSha = null
const ref0 = await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
if (ref0.status === 404 || ref0.status === 409) {
  console.log('repository is empty -> seeding an initial commit')
  await call('PUT', `/repos/${OWNER}/${REPO}/contents/README.md`, {
    message: 'init',
    content: Buffer.from('# dsh-skill-market\n', 'utf8').toString('base64'),
  })
}
const refNow = await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
parentSha = refNow.json?.object?.sha ?? null

// 3. build one tree: text files inline, anything non-UTF-8 as a base64 blob
const tree = []
let blobs = 0
for (const file of files) {
  const abs = path.join(root, file)
  const st = statSync(abs)
  if (!st.isFile()) continue
  const buf = readFileSync(abs)
  const text = buf.toString('utf8')
  const isCleanText = !text.includes('\u0000') && Buffer.from(text, 'utf8').equals(buf)
  if (isCleanText) {
    tree.push({ path: file, mode: '100644', type: 'blob', content: text })
  } else {
    const blob = await call('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' })
    tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.json.sha })
    blobs += 1
  }
}
if (blobs) console.log(`binary blobs uploaded: ${blobs}`)
const treeRes = await call('POST', `/repos/${OWNER}/${REPO}/git/trees`, { tree })
console.log(`tree created: ${treeRes.json.sha.slice(0, 10)} (${tree.length} entries)`)

// 3. commit it, 4. point main at it
const commitRes = await call('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
  message: 'feat: dsh-skill-market 0.1.0 (skill search + install + index-driven market)',
  tree: treeRes.json.sha,
  ...(parentSha ? { parents: [parentSha] } : {}),
})
console.log(`commit created: ${commitRes.json.sha.slice(0, 10)}`)

const existingRef = await call('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`)
if (existingRef.status === 404) {
  await call('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: 'refs/heads/main', sha: commitRes.json.sha })
  console.log('branch main created')
} else {
  await call('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha: commitRes.json.sha, force: true })
  console.log('branch main updated')
}

// 5. give it a description/homepage + make main the default branch
await call('PATCH', `/repos/${OWNER}/${REPO}`, {
  description: 'Skill marketplace for DeepSeek Harness: search skillsmp / skillstore / skills.sh / GitHub, install and uninstall skills.',
  homepage: `https://github.com/${OWNER}/${REPO}`,
  default_branch: 'main',
})

// 6. verify anonymously: raw file + package.json
const rawBase = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main`
for (const f of ['package.json', 'README.md', 'cordis.patch.yml', 'client/client.js']) {
  const res = await fetch(`${rawBase}/${f}`)
  console.log(`raw ${f}: ${res.status}`)
}
const readme = await (await fetch(`${rawBase}/README.md`)).text()
console.log(`README first line: ${readme.split('\n')[0]}`)
console.log(`\npublished: https://github.com/${OWNER}/${REPO}`)
console.log(`commit: ${commitRes.json.sha}`)
