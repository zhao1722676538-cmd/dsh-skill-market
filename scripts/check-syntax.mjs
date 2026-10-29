#!/usr/bin/env node
/**
 * 零依赖的语法检查：对 src/ scripts/ test/ client/ 下每个 .js/.mjs 跑 `node --check`。
 *
 * 这个项目刻意不拉 eslint/tsc/打包链路（见 RECOMMENDATIONS §10），
 * CI 里至少要保证「所有文件都还能被解析」，这一条不需要任何依赖。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOTS = ['src', 'scripts', 'test', 'client']
const files = []

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(js|mjs)$/.test(entry.name)) files.push(full)
  }
}

for (const root of ROOTS) {
  try {
    if (statSync(root).isDirectory()) walk(root)
  } catch {
    // 目录不存在就跳过（例如精简过的部署副本）
  }
}

let failed = 0
for (const file of files.sort()) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    failed += 1
    console.error(`FAIL ${file}\n${err.stderr?.toString() ?? err.message}`)
  }
}

console.log(`${files.length - failed}/${files.length} files parse cleanly`)
process.exit(failed > 0 ? 1 : 0)
