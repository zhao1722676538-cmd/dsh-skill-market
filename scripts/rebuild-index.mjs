#!/usr/bin/env node
/**
 * 重建仓库根目录的 skill-index.json，查询词直接沿用现有文件里的 `queries`。
 *
 * 为什么不写死关键词：README 里的示例命令和实际索引里的词表很容易漂移，
 * 而定时任务只要读上一次的 queries，就永远和人工构建保持一致。
 *
 *   node scripts/rebuild-index.mjs [--out skill-index.json] [--limit 10]
 *
 * 一条查询都没拿到结果时不会覆盖旧文件（退出码 1），避免把好索引刷成空。
 */
import fs from 'node:fs/promises'

import { buildIndex } from '../src/index-build.js'
import { serializeIndex } from '../src/index-store.js'
import { createHttp } from '../src/net.js'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const out = argOf('--out', 'skill-index.json')
const limit = Number(argOf('--limit', 10)) || 10

const previous = JSON.parse(await fs.readFile(out, 'utf8'))
const queries = Array.isArray(previous.queries) ? previous.queries : []
if (queries.length === 0) {
  throw new Error(`${out} carries no queries to reuse; use scripts/build-index.mjs --query ... instead`)
}

console.log(`rebuilding ${queries.length} queries -> ${out}`)
const index = await buildIndex({
  queries,
  perSourceLimit: limit,
  deps: { http: createHttp({ timeoutMs: 20000 }), log: (message) => console.log(`  ${message}`) },
})

const okQueries = index.reports.filter((report) => report.ok && report.count > 0).length
if (okQueries === 0) {
  console.error('no query produced any entry; keeping the existing index untouched')
  process.exit(1)
}

await fs.writeFile(out, serializeIndex(index), 'utf8')
console.log(`wrote ${index.skills.length} skills (${okQueries}/${index.reports.length} queries ok)`)
