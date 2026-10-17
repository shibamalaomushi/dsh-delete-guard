/**
 * dsh-delete-guard 发布前敏感信息扫描
 *
 * 开源发布前的最后一道闸门：递归扫描目标目录里的**所有文本文件**，命中任一禁项即失败。
 * 禁项分三类：
 *   1) 绝对用户路径 / 家目录（各平台）—— 会把维护者的用户名与目录结构带出去；
 *   2) 身份信息（邮箱、主机名占位、社交账号）与常见密钥形态（私钥头、GitHub/Slack/OpenAI token）；
 *   3) 仓库自定义禁词：环境变量 DSM_FORBIDDEN 里以英文逗号分隔的词（例如你的真实用户名）。
 *
 * 只按纯文本读取；二进制文件（图片等）跳过，但会单独列出以提醒人工确认。
 *
 * 用法：node test/sensitive-scan.mjs [目录]        （默认：本包目录）
 *      DSM_FORBIDDEN=alice,myhost node test/sensitive-scan.mjs .
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..'))

const BUILTIN = [
  // 1) 绝对路径 / 家目录
  /[A-Za-z]:[\\/]{1,2}Users[\\/]/i,
  /[A-Za-z]:[\\/]{1,2}Documents[\\/]/i,
  /\/(?:home|Users)\/[A-Za-z0-9._-]+\//,
  /\/root\//,
  // 2) 身份与密钥形态
  /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bDESKTOP-[A-Z0-9]{7}\b/,
]

const custom = String(process.env.DSM_FORBIDDEN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const hostUser = path.basename(os.homedir())
const extra = custom.length ? custom : [hostUser]

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml', '.md', '.txt', '.svg', '.css', '.html',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmignore', '',
])

let scanned = 0
let hits = 0
const binaries = []
const findings = []

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    const ext = path.extname(entry.name).toLowerCase()
    if (!TEXT_EXT.has(ext)) {
      binaries.push(path.relative(ROOT, full))
      continue
    }
    const text = fs.readFileSync(full, 'utf8')
    scanned += 1
    const lines = text.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      for (const pattern of [...BUILTIN, ...extra.map((word) => new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))]) {
        if (pattern.test(line)) {
          hits += 1
          findings.push(`${path.relative(ROOT, full)}:${index + 1}  [${String(pattern)}]  ${line.trim().slice(0, 120)}`)
        }
      }
    }
  }
}

if (!fs.existsSync(ROOT)) {
  console.error(`目录不存在：${ROOT}`)
  process.exit(2)
}
walk(ROOT)

console.log(`扫描目录：${ROOT}`)
console.log(`文本文件：${scanned} 个；非文本（已跳过，请人工确认）：${binaries.length} 个`)
if (binaries.length) for (const file of binaries) console.log(`  · ${file}`)
console.log(`自定义禁词：${extra.join(', ') || '（无）'}`)

if (hits) {
  console.log(`\n发现 ${hits} 处命中，发布前必须处理：`)
  for (const line of findings) console.log(`  ${line}`)
  process.exit(1)
}
console.log('\n未发现敏感信息。')
