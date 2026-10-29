/**
 * tar 解析器与安装器的行为测试（此前这两块零测试）。
 *
 * 重点不是覆盖率数字，而是「归档来自第三方仓库，因此每一条路径都必须
 * 被当成恶意输入」这条线：路径逃逸、坏 checksum、截断、解压炸弹、
 * Windows 非法文件名、本地改动检测。
 *
 * 全部离线：没有任何 API 请求，GitHub 侧用按 URL 分发的假 http 替代。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'

import { clearArchiveCache } from '../src/install/github.js'
import { installSkill, listInstalled, uninstallSkill } from '../src/install/installer.js'
import { MAX_UNCOMPRESSED_BYTES, parseTar, readTarGz } from '../src/install/tar.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const BLOCK = 512

/* ------------------------------------------------------------------ */
/* tar 构造工具                                                        */
/* ------------------------------------------------------------------ */

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`

/**
 * @param {{name: string, size?: number, type?: string, mode?: number}} fields
 */
function tarHeader({ name, size = 0, type = '0', mode = 0o644 }) {
  const header = Buffer.alloc(BLOCK)
  header.write(name, 0, 100, 'utf8')
  header.write(octal(mode, 8), 100, 8, 'ascii')
  header.write(octal(0, 8), 108, 8, 'ascii')
  header.write(octal(0, 8), 116, 8, 'ascii')
  header.write(octal(size, 12), 124, 12, 'ascii')
  header.write(octal(0, 12), 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii') // 校验和位置先填 8 个空格
  header.write(type, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** pax 记录：`<总长度> key=value\n`，长度包含自身数字 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (String(length).length + body.length !== length) length += 1
  return `${length}${body}`
}

/**
 * @param {{path: string, data?: Buffer|string, type?: string}[]} entries
 * @returns {Buffer}
 */
function buildTar(entries) {
  const blocks = []
  for (const entry of entries) {
    const data = entry.data === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const type = entry.type ?? '0'
    blocks.push(tarHeader({ name: entry.path, size: type === '5' ? 0 : data.length, type }))
    if (type !== '5' && data.length > 0) {
      blocks.push(data)
      const padding = (BLOCK - (data.length % BLOCK)) % BLOCK
      if (padding > 0) blocks.push(Buffer.alloc(padding))
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2)) // 两个零块表示归档结束
  return Buffer.concat(blocks)
}

/**
 * 造一个可被 GitHub 读取的 tarball：顶层目录固定为 `<repo>-<sha>/`。
 * @param {{path: string, data?: string|Buffer, type?: string}[]} files 顶层目录以下相对路径
 */
function repoTarball(files, { topDir = `skills-${SHA}` } = {}) {
  return zlib.gzipSync(buildTar([
    { path: `${topDir}/`, type: '5' },
    ...files.map((file) => ({ ...file, path: `${topDir}/${file.path}` })),
  ]))
}

/** 用流式 gzip 造一个解压后远超上限的「炸弹」，避免测试里真的分配 257 MiB */
async function gzipBomb(totalBytes) {
  const chunk = Buffer.alloc(1024 * 1024)
  const chunks = []
  const gzip = zlib.createGzip({ level: 1 })
  const finished = new Promise((resolve, reject) => {
    gzip.on('data', (data) => chunks.push(data))
    gzip.on('end', resolve)
    gzip.on('error', reject)
  })
  for (let written = 0; written < totalBytes; written += chunk.length) gzip.write(chunk)
  gzip.end()
  await finished
  return Buffer.concat(chunks)
}

/* ------------------------------------------------------------------ */
/* 假 http / 假 installRoot                                            */
/* ------------------------------------------------------------------ */

/**
 * 按 URL 分发的假 fetch：只覆盖安装路径真正会打的三个端点。
 * @param {{archive?: Buffer, contentLength?: number, defaultBranch?: string}} options
 */
function fakeHttp(options = {}) {
  const archive = options.archive ?? Buffer.alloc(0)
  return async (url) => {
    if (url.includes('codeload.github.com')) {
      const headers = new Map()
      const declared = options.contentLength ?? archive.length
      headers.set('content-length', String(declared))
      return {
        ok: true,
        status: 200,
        headers,
        arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
        json: async () => ({}),
      }
    }
    if (url.includes('/commits/')) {
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ sha: SHA }) }
    }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ default_branch: options.defaultBranch ?? 'main' }),
    }
  }
}

const TMP_BASE = path.join(process.cwd(), '.test-tmp')

async function tempRoot() {
  await fs.mkdir(TMP_BASE, { recursive: true })
  return fs.mkdtemp(path.join(TMP_BASE, 'root-'))
}

/** @param {{repo?: string, path?: string}} overrides */
function skillEntry(overrides = {}) {
  return {
    source: 'github',
    id: 'demo/skills:pdf',
    name: 'pdf',
    repo: 'demo/skills',
    path: 'pdf',
    ...overrides,
  }
}

const skillFiles = [
  { path: 'pdf/SKILL.md', data: '---\nname: pdf\ndescription: PDF helpers\n---\n\n# pdf\n' },
  { path: 'pdf/reference.md', data: 'thick reference\n' },
]

/* ------------------------------------------------------------------ */
/* parseTar / readTarGz                                                */
/* ------------------------------------------------------------------ */

test('parseTar reads regular files and directory entries', () => {
  const entries = parseTar(buildTar([
    { path: 'a/', type: '5' },
    { path: 'a/b.md', data: 'hello' },
  ]))
  assert.deepEqual(entries.map((entry) => entry.path), ['a', 'a/b.md'])
  assert.equal(entries[0].type, 'dir')
  assert.equal(entries[1].type, 'file')
  assert.equal(entries[1].data.toString('utf8'), 'hello')
  assert.equal(entries[1].size, 5)
})

test('parseTar leaves traversal paths for the installer to reject', () => {
  const entries = parseTar(buildTar([{ path: 'skills/x/../../etc/passwd', data: 'pwned' }]))
  assert.equal(entries[0].path, 'skills/x/../../etc/passwd')
  assert.match(entries[0].path, /\.\.\//)
})

test('parseTar honours a pax path record', () => {
  const record = Buffer.from(paxRecord('path', 'deep/nested/target.md'), 'utf8')
  const raw = Buffer.concat([
    tarHeader({ name: 'PaxHeader', size: record.length, type: 'x' }),
    record,
    Buffer.alloc((BLOCK - (record.length % BLOCK)) % BLOCK),
    tarHeader({ name: 'placeholder', size: 4 }),
    Buffer.from('body'),
    Buffer.alloc(BLOCK * 2),
  ])
  const entries = parseTar(raw)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].path, 'deep/nested/target.md')
  assert.equal(entries[0].data.toString('utf8'), 'body')
})

test('parseTar rejects a corrupted header checksum', () => {
  const raw = buildTar([{ path: 'a.md', data: 'x' }])
  raw[0] = 0x41 // 改掉 name 首字节，校验和必然对不上
  assert.throws(() => parseTar(raw), (err) => err.code === 'EINVALID_TAR')
})

test('parseTar rejects a file whose data runs past the end', () => {
  const header = tarHeader({ name: 'truncated.md', size: 4096 })
  const raw = Buffer.concat([header, Buffer.from('short')])
  assert.throws(() => parseTar(raw), (err) => err.code === 'ETRUNCATED_TAR')
})

test('readTarGz rejects non-gzip bytes', async () => {
  await assert.rejects(readTarGz(Buffer.from('this is not gzip')), (err) => err.code === 'EINVALID_GZIP')
})

test('readTarGz rejects an empty buffer', async () => {
  await assert.rejects(readTarGz(Buffer.alloc(0)), (err) => err.code === 'EINVALID_GZIP')
})

test('readTarGz caps the decompressed size (gzip bomb)', async () => {
  assert.equal(MAX_UNCOMPRESSED_BYTES, 256 * 1024 * 1024)
  const bomb = await gzipBomb(MAX_UNCOMPRESSED_BYTES + 1024 * 1024)
  await assert.rejects(readTarGz(bomb), (err) => err.code === 'EARCHIVE_TOO_LARGE')
})

test('readTarGz reads a real tarball end to end', async () => {
  const entries = await readTarGz(repoTarball(skillFiles))
  assert.ok(entries.some((entry) => entry.path === `skills-${SHA}/pdf/SKILL.md`))
})

/* ------------------------------------------------------------------ */
/* installSkill                                                        */
/* ------------------------------------------------------------------ */

test('installSkill writes the skill directory and records per-file hashes', async () => {
  const installRoot = await tempRoot()
  clearArchiveCache()
  try {
    const result = await installSkill(skillEntry(), {
      installRoot,
      deps: { http: fakeHttp({ archive: repoTarball(skillFiles) }) },
    })

    assert.equal(result.ok, true)
    assert.equal(result.name, 'pdf')
    assert.equal(result.files, 2)
    assert.equal(result.commit, SHA)
    assert.equal(result.ref, SHA)
    assert.deepEqual(result.warnings, [])

    const skillMd = await fs.readFile(path.join(installRoot, 'pdf', 'SKILL.md'), 'utf8')
    assert.match(skillMd, /^---\nname: pdf/)

    const registry = JSON.parse(await fs.readFile(path.join(installRoot, '.skill-market', 'registry.json'), 'utf8'))
    const record = registry.skills.pdf
    assert.equal(record.repo, 'demo/skills')
    assert.equal(record.path, 'pdf')
    assert.deepEqual(record.files.map((file) => file.path).sort(), ['SKILL.md', 'reference.md'])
    for (const file of record.files) assert.match(file.sha256, /^[0-9a-f]{64}$/)

    const listed = await listInstalled({ installRoot })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].present, true)
    assert.equal(listed[0].files, 2)
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true })
  }
})

test('installSkill refuses to clobber an unmanaged directory unless overwrite is set', async () => {
  const installRoot = await tempRoot()
  clearArchiveCache()
  try {
    await fs.mkdir(path.join(installRoot, 'pdf'), { recursive: true })
    await fs.writeFile(path.join(installRoot, 'pdf', 'hand-written.md'), 'mine\n')

    await assert.rejects(
      installSkill(skillEntry(), { installRoot, deps: { http: fakeHttp({ archive: repoTarball(skillFiles) }) } }),
      (err) => err.code === 'EEXIST_UNMANAGED',
    )

    const forced = await installSkill(skillEntry(), {
      installRoot,
      overwrite: true,
      deps: { http: fakeHttp({ archive: repoTarball(skillFiles) }) },
    })
    assert.equal(forced.updated, true)
    await assert.rejects(fs.access(path.join(installRoot, 'pdf', 'hand-written.md')))
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true })
  }
})

test('installSkill skips paths that escape the staging directory', async () => {
  const installRoot = await tempRoot()
  clearArchiveCache()
  try {
    const archive = repoTarball([
      ...skillFiles,
      { path: 'pdf/../../escaped.md', data: 'pwned\n' },
    ])
    const result = await installSkill(skillEntry(), {
      installRoot,
      deps: { http: fakeHttp({ archive }) },
    })

    assert.equal(result.ok, true)
    assert.ok(
      result.warnings.some((warning) => warning.includes('skipped unsafe archive path')),
      `expected an unsafe-path warning, got ${JSON.stringify(result.warnings)}`,
    )
    await assert.rejects(fs.access(path.join(installRoot, '..', 'escaped.md')))
    await assert.rejects(fs.access(path.join(installRoot, 'escaped.md')))
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true })
  }
})

test('installSkill skips names Windows cannot create instead of failing the install', async () => {
  const installRoot = await tempRoot()
  clearArchiveCache()
  try {
    const result = await installSkill(skillEntry(), {
      installRoot,
      deps: {
        http: fakeHttp({
          archive: repoTarball([
            ...skillFiles,
            { path: 'pdf/con.md', data: 'reserved\n' },
            { path: 'pdf/trailing.dot.', data: 'reserved\n' },
            { path: 'pdf/bad:name.md', data: 'reserved\n' },
          ]),
        }),
      },
    })

    assert.equal(result.ok, true)
    const warnings = result.warnings.filter((warning) => warning.includes('not a legal file name on Windows'))
    assert.equal(warnings.length, 3, JSON.stringify(result.warnings))
    const installed = await fs.readdir(path.join(installRoot, 'pdf'))
    assert.deepEqual(installed.sort(), ['SKILL.md', 'reference.md'])
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true })
  }
})

test('installSkill rejects an archive whose declared size is over the limit', async () => {
  const installRoot = await tempRoot()
  clearArchiveCache()
  try {
    await assert.rejects(
      installSkill(skillEntry(), {
        installRoot,
        deps: { http: fakeHttp({ archive: repoTarball(skillFiles), contentLength: 65 * 1024 * 1024 }) },
      }),
      (err) => err.code === 'EARCHIVE_TOO_LARGE',
    )
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* uninstallSkill                                                      */
/* ------------------------------------------------------------------ */

test('uninstallSkill reports unmanaged directories instead of deleting them', async () => {
  const installRoot = await tempRoot()
  try {
    await fs.mkdir(path.join(installRoot, 'handmade'), { recursive: true })
    const result = await uninstallSkill('handmade', { installRoot })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unmanaged')
    await fs.access(path.join(installRoot, 'handmade'))
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true })
  }
})

test('uninstallSkill detects local edits and only removes them when forced', async () => {
  const installRoot = await tempRoot()
  clearArchiveCache()
  try {
    await installSkill(skillEntry(), {
      installRoot,
      deps: { http: fakeHttp({ archive: repoTarball(skillFiles) }) },
    })
    await fs.writeFile(path.join(installRoot, 'pdf', 'reference.md'), 'locally edited\n')
    await fs.writeFile(path.join(installRoot, 'pdf', 'notes.md'), 'added by me\n')

    const blocked = await uninstallSkill('pdf', { installRoot })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, 'modified')
    assert.ok(blocked.conflicts.some((conflict) => conflict.startsWith('changed: reference.md')))
    assert.ok(blocked.conflicts.some((conflict) => conflict.startsWith('added: notes.md')))
    await fs.access(path.join(installRoot, 'pdf', 'reference.md'))

    const forced = await uninstallSkill('pdf', { installRoot, force: true })
    assert.equal(forced.ok, true)
    await assert.rejects(fs.access(path.join(installRoot, 'pdf')))
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true })
  }
})

test('uninstallSkill removes a clean install and its registry record', async () => {
  const installRoot = await tempRoot()
  clearArchiveCache()
  try {
    await installSkill(skillEntry(), {
      installRoot,
      deps: { http: fakeHttp({ archive: repoTarball(skillFiles) }) },
    })

    const result = await uninstallSkill('pdf', { installRoot })
    assert.equal(result.ok, true)
    await assert.rejects(fs.access(path.join(installRoot, 'pdf')))

    const registry = JSON.parse(await fs.readFile(path.join(installRoot, '.skill-market', 'registry.json'), 'utf8'))
    assert.equal(registry.skills.pdf, undefined)
  } finally {
    await fs.rm(installRoot, { recursive: true, force: true })
  }
})
