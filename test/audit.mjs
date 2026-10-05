/**
 * dsh-delete-guard 静态清单审计
 *
 * 按内核的装载规则检查一个包目录（默认当前目录，或 argv[2] 指定的已安装副本）：
 * manifest 必备字段、client 出口、locale 元数据入口、patch 行、两个半身的关键约定、
 * 中英字典键集合一致、不 import 内核包、接口前缀不越过内核鉴权。
 *
 * 用法：node test/audit.mjs [包目录]
 */
import fs from 'node:fs'
import path from 'node:path'

const PKG = process.argv[2] ?? path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..')
const NAME = 'dsh-delete-guard'
let pass = 0
let fail = 0
const check = (n, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`ok   ${n}`)
  } else {
    fail += 1
    console.log(`FAIL ${n} ${extra}`)
  }
}
const read = (p) => fs.readFileSync(path.join(PKG, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(PKG, p))
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// 1) manifest
const pkg = JSON.parse(read('package.json'))
check('包名与目录名一致', pkg.name === NAME, pkg.name)
check('版本是合法 semver', /^\d+\.\d+\.\d+$/.test(String(pkg.version)), String(pkg.version))
check('license 已声明', typeof pkg.license === 'string' && pkg.license.length > 0, String(pkg.license))
check('dsh.bundle.patch 声明且文件存在', pkg.dsh?.bundle?.patch === './cordis.patch.yml' && exists('cordis.patch.yml'))
check('dsh.client.platform 是 web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('dsh.client.immediately 是布尔', typeof pkg.dsh?.client?.immediately === 'boolean')
check('exports 暴露 ./client', typeof pkg.exports?.['./client'] === 'string', JSON.stringify(pkg.exports))
check('exports 暴露 ./locale/*.json', typeof pkg.exports?.['./locale/*.json'] === 'string')
check('files 含运行期文件', Array.isArray(pkg.files) && ['index.js', 'client.js', 'locale', 'icon.svg', 'cordis.patch.yml'].every((f) => pkg.files.includes(f)))
check('files 不含 test/ 与文档目录（安装副本保持精简）', Array.isArray(pkg.files) && !pkg.files.some((f) => /^test|^\.github|^docs/.test(f)))
check('icon 指向存在的文件', typeof pkg.icon === 'string' && fs.existsSync(path.join(PKG, pkg.icon)), String(pkg.icon))
check('npm test 脚本存在', typeof pkg.scripts?.test === 'string', String(pkg.scripts?.test))

// 2) 内核按 <pkg>/locale/en.json 作为展示元数据入口
const en = JSON.parse(read('locale/en.json'))
const zh = JSON.parse(read('locale/zh.json'))
check('locale/en.json 有非空 meta.title', typeof en.meta?.title === 'string' && en.meta.title.length > 0)
check('locale/en.json 有非空 meta.description', typeof en.meta?.description === 'string' && en.meta.description.length > 0)
check('locale/zh.json 有非空 meta.title/description', typeof zh.meta?.title === 'string' && zh.meta.title.length > 0 && typeof zh.meta?.description === 'string' && zh.meta.description.length > 0)

// 3) patch 行：id 与包名一致（浏览器半身绑定在裸包名那一行上）
const patch = read('cordis.patch.yml')
check('patch 用裸包名插入', /insert:/.test(patch) && (patch.includes(`name: '${NAME}'`) || patch.includes(`name: ${NAME}`)))
check('patch 的 id 与包名一致', new RegExp(`id:\\s*${NAME}\\b`).test(patch))

// 4) 浏览器半身
const client = read('client.js')
check('client.js 用 __ModuleLoader__.load 注册', client.includes('__ModuleLoader__.load('))
check('client.js 的工厂 id 等于包名', new RegExp(`id:\\s*'${NAME}'`).test(client))
check('client.js 注册 sidebar.panellist 侧边栏入口', client.includes("'sidebar.panellist'"))
check('client.js 注册 main 面板（keyed）', /name:\s*'main'[\s\S]{0,80}key:\s*PANEL_ID/.test(client))
check(
  'client.js 提供多个入口（面板 + 会话行悬停按钮 + 会话行右键菜单）',
  ['sidebar.panellist', 'sidebar.workspaces.session.row.action', 'sidebar.workspaces.session.menu.item'].every((slot) =>
    client.includes(slot),
  ),
)
check(
  'client.js 有批量 / 分类 / 策略 / 确认词文案',
  ['batchTrash', 'batchPurge', 'batchRestore', 'catAll', 'policyReadOnly', 'typedConfirmLabel', 'selectedCount'].every((key) =>
    client.includes(`${key}:`),
  ),
)
check('client.js 只 require react（不 import 内核 Client 包）', (() => {
  const code = stripComments(client)
  return /require\('react'\)/.test(code) && !/require\(['"]@deepseek-ai|from\s+['"]@deepseek-ai/.test(code)
})())
check('client.js 只用主题 token 着色（无字面色值）', !/#[0-9a-fA-F]{3,6}\b/.test(stripComments(client)))
check('client.js 有中英双字典且键集合一致', (() => {
  const grab = (name) => {
    const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n    \\}`).exec(client)
    if (!m) return null
    return new Set([...m[1].matchAll(/^\s{6}([A-Za-z0-9_]+):/gm)].map((x) => x[1]))
  }
  const a = grab('zh')
  const b = grab('en')
  if (!a || !b) return false
  return a.size === b.size && [...a].every((k) => b.has(k))
})())

// 5) Host 半身
const host = read('index.js')
check('index.js 导出 apply 函数', /export function apply\(/.test(host))
check('index.js 的硬依赖只有 webServer', /export const inject = \['webServer'\]/.test(host))
check('index.js 用可选 fiber 接会话服务（缺失不会整体不激活）', host.includes("ctx.inject(['sessions']"))
check('index.js 用可选 fiber 接斜杠命令服务', host.includes("ctx.inject(['commands']"))
check('index.js 不 import 任何内核包', !/@deepseek-ai\//.test(stripComments(host)))
check('index.js 有会话 id 与目录守卫', host.includes('SESSION_ID_RE') && host.includes('sessionDirOf'))
check('index.js 有回收站、还原与彻底删除', host.includes('moveToTrash') && host.includes('function restore') && host.includes('function purge'))
check('index.js 还原前校验原路径（防篡改）', host.includes('bad-meta') && host.includes('validOriginal'))
check('index.js 有信任围栏', host.includes('isLoopbackHostname') && host.includes('sec-fetch-site'))
check('index.js 有审计日志', host.includes('log.jsonl'))
check(
  'index.js 有批量接口与策略闸门',
  ['delete-batch', 'restore-batch', 'purge-batch'].every((p) => host.includes(p)) &&
    host.includes('assertPolicy') &&
    host.includes('assertPurgeAllowed') &&
    host.includes('assertTypedConfirm'),
)
check(
  'index.js 的批量上限 / 确认阈值 / 确认词可配置',
  host.includes('maxBatchSize') && host.includes('requireTypedConfirmAt') && host.includes("'PURGE'"),
)
check('index.js 的 /list 会下发策略与不可删原因', host.includes('policy: POLICY') && host.includes('blockedReason'))
check(
  'index.js 的策略判定集中在一处（单条 / 清空回收站 / 列表共用同一函数）',
  (host.match(/trashPolicyRejection\(/g) ?? []).length >= 3 && host.includes('policyBlockForId'),
)
check('index.js 清空回收站逐条过策略并如实报告跳过项', host.includes("return 'orphan'") && host.includes('skippedCodes'))
check(
  'index.js 进回收站先写 meta 再搬正文（条目永远可归属）',
  host.includes('complete: false') && host.includes('complete: true') && host.includes('trash-failed'),
)
check('index.js 排队也要过策略闸门（避免队列里堆永远删不掉的条目）', host.includes('assertQueueable'))
check(
  'index.js 队列里的永久失败项会被丢弃而不是每次启动重试',
  host.includes("result: permanent ? 'dropped' : 'failed'") && host.includes('const permanent = ['),
)
check('index.js 的策略文案集中在一处', host.includes('POLICY_MESSAGES'))
check('接口前缀不是 /api（不越过内核鉴权）', host.includes("'/dsh-delete-guard/api'") && !host.includes("'/api"))
// 盘符形式的绝对路径（排除 https:// 这类 URL：字母前必须是行首或非单词字符，且不得紧接 //）
const ABS_PATH = /(^|[^\w])[A-Za-z]:[\\/](?![\\/])/m
check('index.js 无硬编码绝对路径', !ABS_PATH.test(stripComments(host)))
check('client.js 无硬编码绝对路径', !ABS_PATH.test(stripComments(client)))

// 6) 设计一致性：行内入口与确认弹窗必须贴着内核设计系统的度量
check('行按钮沿用内核 iconButton 度量（16×16 / 圆角 xs / tertiary 色 / hover 只变色）',
  client.includes('.dsm-iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary)') &&
    client.includes('.dsm-iconButton:hover{color:var(--dsw-alias-label-primary)}'))
check('行按钮图标 14px 且外接 500ms 气泡（bottom/end/gap 8）',
  client.includes('h(TrashIcon, { size: 14 })') && client.includes('rect.bottom + 8') && client.includes('}, 500)'))
check('气泡度量取自内核 Tooltip（tooltip-bg / 3px 7px / 圆角 sm）',
  client.includes('padding:3px 7px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-tooltip-bg)'))
check('菜单项沿用 MenuItemButton 度量（34px / 13px / 圆角 md / 图标 14px / menu-icon 色）',
  client.includes('min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md)') &&
    client.includes('color:var(--dsw-alias-menu-icon)'))
check('菜单项 role=menuitem 且点击后关闭菜单', client.includes("role: 'menuitem'") && client.includes('closeMenu(props)'))
check('弹窗沿用 Modal 度量（bg-mask-1 / radius-panel / layer-2 / elevation-prominent）',
  client.includes('--dsw-alias-bg-mask-1') && client.includes('--dsw-radius-panel') &&
    client.includes('--dsw-alias-bg-layer-2') && client.includes('--dsw-elevation-prominent'))
check('弹窗 header / footer 与内核一致（22/14/12/24、min-width 72/136、gap 8）',
  client.includes('padding:22px 14px 12px 24px') && client.includes('.dsm-modalAction{min-width:72px}') &&
    client.includes('.dsm-confirmAction{min-width:136px}'))
check('确认按钮用 primary（设计系统没有 danger 按钮变体），危险感由 warning 承担',
  client.includes("className: 'dsm-btn dsm-btn-primary dsm-confirmAction'") &&
    client.includes('dsm-warningIcon') && client.includes('--dsw-alias-state-error-primary'))
check('图标路径逐字取自设计系统（trash / warning / close）',
  client.includes('M1.28149 3.88831H14.7187') && client.includes('M8 10.708V11.708') && client.includes("'M2.5 2.5L13.5 13.5'"))
console.log(`\n静态审计：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
