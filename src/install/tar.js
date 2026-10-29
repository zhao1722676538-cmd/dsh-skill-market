/**
 * 最小 tar(.gz) 读取器 —— 只用 node:zlib，零第三方依赖。
 *
 * 支持：
 *  - ustar / GNU tar / POSIX pax 头
 *  - GNU longname (`L`) / longlink (`K`)
 *  - pax extended header (`x`) 与 global pax (`g`)
 *  - v7 风格的普通头（无 magic）
 *
 * 安全约定（见 SPEC §5.1）：
 *  - 只解析，**绝不写盘**
 *  - symlink / hardlink / 字符设备 / 块设备 / fifo 一律归一化为 `type:'other'`，不携带 data
 *  - 路径不做安全清洗（`../` 原样保留），由 installer 统一校验前缀；这样逃逸能被发现并报错
 *    —— 不会因为“悄悄丢掉”一个恶意路径而掩盖问题。
 *
 * @module dsh-skill-market/install/tar
 */

import zlib from 'node:zlib'

const BLOCK = 512

/**
 * 单次解压的硬上限（解压后字节数）。
 * gzip 的最小压缩比可以到 1:1000，一个几百 KB 的 tar.gz 能撑出几 GB —— 必须在
 * 解压这一步就截断，不能等 parseTar 之后的 MAX_TOTAL_BYTES 再拦（那时内存已经没了）。
 */
export const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024

/** tar 头字段偏移 */
const F = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  chksum: [148, 8],
  typeflag: [156, 1],
  linkname: [157, 100],
  magic: [257, 6],
  version: [263, 2],
  uname: [265, 32],
  gname: [297, 32],
  devmajor: [329, 8],
  devminor: [337, 8],
  prefix: [345, 155],
}

function tarError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** 读取 NUL 结尾的字符串字段 */
function readString(block, offset, length) {
  const slice = block.subarray(offset, offset + length)
  const nul = slice.indexOf(0)
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8')
}

/**
 * 读取八进制数字字段；同时兼容 GNU base-256 编码（首字节高位为 1）。
 * 空字段视为 0。
 */
function readOctal(block, offset, length) {
  const first = block[offset]
  if (first & 0x80) {
    // GNU base-256：忽略符号位，剩余字节按大端整数
    let value = first & 0x7f
    for (let i = 1; i < length; i++) value = value * 256 + block[offset + i]
    return value
  }
  const text = readString(block, offset, length).trim()
  if (!text) return 0
  const value = parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false
  return true
}

/** 校验头校验和（无符号口径；也接受补码口径的老 tar） */
function verifyChecksum(block) {
  const expected = readOctal(block, F.chksum[0], F.chksum[1])
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i++) {
    const inField = i >= F.chksum[0] && i < F.chksum[0] + F.chksum[1]
    const byte = inField ? 0x20 : block[i]
    unsigned += byte
    signed += inField ? 0x20 : byte > 127 ? byte - 256 : byte
  }
  return expected === unsigned || expected === signed
}

/** 拼出完整路径（GNU/ustar 的 prefix + name） */
function headerName(block) {
  const name = readString(block, F.name[0], F.name[1])
  const prefix = readString(block, F.prefix[0], F.prefix[1])
  return prefix ? `${prefix}/${name}` : name
}

/** 归一化路径：去 `./` 前缀、去重复 `/`、去尾部 `/`；**不动 `..`** */
function normalizePath(raw) {
  let p = String(raw || '').replace(/\\/g, '/')
  p = p.replace(/\/{2,}/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  p = p.replace(/\/+$/, '')
  return p
}

/** 解析 pax 扩展头记录：`<len> <key>=<value>\n`（长度包含自身） */
function parsePaxRecords(buf) {
  const out = {}
  let i = 0
  while (i < buf.length) {
    const space = buf.indexOf(0x20, i)
    if (space === -1) break
    const len = parseInt(buf.subarray(i, space).toString('latin1'), 10)
    if (!Number.isFinite(len) || len <= 0 || i + len > buf.length) break
    const record = buf.subarray(i, i + len).toString('utf8')
    const eq = record.indexOf('=')
    if (eq !== -1) {
      const key = record.slice(space - i + 1, eq)
      let value = record.slice(eq + 1)
      const nl = value.lastIndexOf('\n')
      if (nl !== -1) value = value.slice(0, nl)
      if (key) out[key] = value
    }
    i += len
  }
  return out
}

/** 一个 tar 条目是否算普通文件 */
function isRegularFile(typeflag) {
  return typeflag === '0' || typeflag === '7'
}

/**
 * 解析**未压缩** tar 字节流。
 * 单独导出便于测试（不需要先 gzip）。
 *
 * @param {Buffer} raw
 * @returns {{path:string, mode:number, type:'file'|'dir'|'other', size:number, data?:Buffer}[]}
 */
export function parseTar(raw) {
  if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw)
  /** @type {{path:string, mode:number, type:'file'|'dir'|'other', size:number, data?:Buffer}[]} */
  const entries = []
  let offset = 0
  let longName = null
  let longLink = null
  let pax = {}
  let globalPax = {}
  let zeroBlocks = 0
  let headerCount = 0

  while (offset + BLOCK <= raw.length) {
    const block = raw.subarray(offset, offset + BLOCK)
    if (isZeroBlock(block)) {
      zeroBlocks++
      offset += BLOCK
      // 规范：文件结束标记是两个连续零块；很多工具只写一个，索性都接受
      if (zeroBlocks >= 2) break
      continue
    }
    zeroBlocks = 0

    if (!verifyChecksum(block)) {
      throw tarError(
        'EINVALID_TAR',
        `bad tar header checksum at byte ${offset} (entry #${headerCount})`,
      )
    }
    headerCount++

    const typeChar = String.fromCharCode(block[F.typeflag[0]] || 0x30)
    let size = readOctal(block, F.size[0], F.size[1])
    const dataStart = offset + BLOCK

    if (typeChar === 'x' || typeChar === 'g') {
      const dataEnd = dataStart + size
      if (dataEnd > raw.length) throw tarError('ETRUNCATED_TAR', 'pax header runs past end of data')
      const records = parsePaxRecords(raw.subarray(dataStart, dataEnd))
      if (typeChar === 'g') globalPax = { ...globalPax, ...records }
      else pax = { ...pax, ...records }
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }

    if (typeChar === 'L' || typeChar === 'K') {
      const dataEnd = dataStart + size
      if (dataEnd > raw.length) throw tarError('ETRUNCATED_TAR', 'long name header runs past end')
      const text = readString(raw.subarray(dataStart, dataEnd), 0, size)
      if (typeChar === 'L') longName = text
      else longLink = text
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }

    const effectivePax = { ...globalPax, ...pax }
    let path = longName ?? effectivePax.path ?? headerName(block)
    if (effectivePax.size !== undefined) {
      const paxSize = parseInt(effectivePax.size, 10)
      if (Number.isFinite(paxSize) && paxSize >= 0) size = paxSize
    }
    path = normalizePath(path)

    const mode = readOctal(block, F.mode[0], F.mode[1])
    /** @type {'file'|'dir'|'other'} */
    let type = 'other'
    if (isRegularFile(typeChar)) type = 'file'
    else if (typeChar === '5') type = 'dir'

    /** @type {any} */
    const entry = { path, mode: mode & 0o7777, type, size }
    // 兼容：linkname 也记录一份（不落盘，仅诊断）
    const link = longLink ?? effectivePax.linkpath ?? readString(block, F.linkname[0], F.linkname[1])
    if (link) entry.linkName = link
    const typeName = typeChar === '5' ? 'dir' : isRegularFile(typeChar) ? 'file' : fromTypeChar(typeChar)
    if (typeName !== 'file' && typeName !== 'dir') entry.typeName = typeName

    const dataEnd = dataStart + size
    if (type === 'file') {
      if (dataEnd > raw.length) {
        throw tarError('ETRUNCATED_TAR', `file "${path}" declares ${size} bytes but archive ends early`)
      }
      entry.data = Buffer.from(raw.subarray(dataStart, dataEnd))
      entry.size = entry.data.length
    }

    if (path) entries.push(entry)
    longName = null
    longLink = null
    pax = {}
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  if (headerCount === 0) throw tarError('EINVALID_TAR', 'no tar headers found')

  return entries
}

function fromTypeChar(typeChar) {
  if (typeChar === '1') return 'hardlink'
  if (typeChar === '2') return 'symlink'
  if (typeChar === '3') return 'chardev'
  if (typeChar === '4') return 'blockdev'
  if (typeChar === '6') return 'fifo'
  return 'other'
}

/**
 * 读取 gzip 压缩的 tar 包（SPEC §5.1 的主入口）。
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {Promise<{path:string, mode:number, type:'file'|'dir'|'other', size:number, data?:Buffer}[]>}
 */
export async function readTarGz(buf) {
  if (!Buffer.isBuffer(buf)) {
    if (buf instanceof Uint8Array) buf = Buffer.from(buf)
    else if (ArrayBuffer.isView(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
    else if (buf instanceof ArrayBuffer) buf = Buffer.from(buf)
    else throw tarError('EINVALID_INPUT', 'readTarGz() expects a Buffer / Uint8Array')
  }
  if (buf.length === 0) throw tarError('EINVALID_GZIP', 'empty gzip buffer')

  let raw
  try {
    raw = zlib.gunzipSync(buf, { maxOutputLength: MAX_UNCOMPRESSED_BYTES })
  } catch (cause) {
    if (cause?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|output length/i.test(String(cause?.message))) {
      throw tarError(
        'EARCHIVE_TOO_LARGE',
        `archive expands past ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MiB; refusing to decompress it`,
      )
    }
    throw tarError('EINVALID_GZIP', `gzip decode failed: ${cause?.message || cause}`)
  }
  return parseTar(raw)
}

export default { readTarGz, parseTar }
