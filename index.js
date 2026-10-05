/**
 * dsh-delete-guard —— Host 半身
 *
 * 目标：安全地删除**单条**会话，绝不影响其它会话；默认移入回收站可还原。
 *
 * 设计依据（均在本机 0.2.0-rc.2 内核上核实）：
 * - 会话落盘：`<DSH_HOME>/sessions/<工作区slug>/<session-id>/session.vN.jsonl[.zstd]`
 *   —— 目录名带格式版本，所以本插件**整目录移动**，不与任何格式耦合。
 * - 持久化层没有任何删除 API（"Nothing deletes session files"），只能由外部移除。
 * - 投影缓存：`<DSH_HOME>/storages/session_projcache/sessions/<session-id>.json`
 *   —— 里面有标题与 cwd，是本插件展示元数据的来源；删除时一并清掉，它会按需重建。
 * - 侧边栏列表来源：`<DSH_HOME>/storages/workspace.json`
 *   —— 只删文件而不清引用，界面会挂着一条打不开的记录，所以引用要一起摘掉。
 * - 活跃会话：`ctx.sessions.list()` 返回**进程内所有活跃会话**，这是权威的"不能删"判据；
 *   删一条正在使用的会话会被写句柄立刻重建，所以必须拒绝（或排入重启后删除）。
 *
 * 安全模型：
 * - 只允许删除"会话根目录下的直接子目录"，id 需匹配严格格式，杜绝路径穿越。
 * - 活跃会话一律拒绝；提供"重启后自动执行"的排队通道。
 * - 默认移入回收站（同一卷 rename，原子）；"彻底删除"需显式调用。
 * - 所有写操作要求请求来自回环 + 同源，拒绝跨站（Sec-Fetch-Site: cross-site / Origin 不匹配），
 *   校验器自身出错一律 fail-closed；宿主 `connection` 栅栏可用时额外委托它。
 * - 全程写审计日志到 `<DSH_HOME>/session-manager/log.jsonl`。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 硬依赖只有 web 服务（没有它就没有浏览器半身可谈）。
 * 会话服务（`ctx.sessions`）用"可选 fiber"接：它在标准 web 组合里一定存在，
 * 但写进 inject 会让插件在缺失时完全不激活——那样用户只会看到"插件不见了"，
 * 而不是"插件明确拒绝删除"。这样写在两种情况下都安全：
 *   服务在 → 活跃判定权威；服务不在 → 判定为 unknown，一律拒绝删除（fail-closed）。
 */
export const inject = ['webServer']

// ───────────────────────────── 路径常量 ─────────────────────────────

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

// 主会话目录名形如 `session-<uuid>`；子代理会话沿用裸 uuid 作为目录名。
// 因此"是否为会话目录"不能只看前缀，还要看它是否真的装着会话日志（见 looksLikeSessionDir）。
const SESSION_ID_RE = /^session-[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/
const ANY_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/
const SESSION_LOG_RE = /^session.*\.jsonl(\.zstd)?$/
const ROUTE_PREFIX = '/dsh-delete-guard/api'

// ───────────────────────────── 小工具 ─────────────────────────────

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 目录里真的装着会话日志才算会话目录。
 * 这道检查让"放宽 id 前缀"不等于"什么目录都敢删"：会话根下若出现非会话目录，
 * 插件既不列出、也拒绝删除。
 */
function looksLikeSessionDir(dir) {
  try {
    return fs.readdirSync(dir).some((name) => SESSION_LOG_RE.test(name))
  } catch {
    return false
  }
}

/** 主会话（`session-…`）还是子代理会话（裸 uuid）。 */
const sessionKind = (id) => (SESSION_ID_RE.test(id) ? 'main' : 'subagent')

function dirBytes(dir) {
  let total = 0
  let newest = 0
  const walk = (d) => {
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      try {
        if (e.isDirectory()) walk(p)
        else {
          const st = fs.statSync(p)
          total += st.size
          if (st.mtimeMs > newest) newest = st.mtimeMs
        }
      } catch {
        /* 忽略单个文件错误 */
      }
    }
  }
  walk(dir)
  return { bytes: total, updatedAt: newest || null }
}

/**
 * 工作区路径 → sessions 下的目录名（projectKey）。
 * 规则（取自内核落盘实现的确认结果）：`\ / :` 连续折叠为单个 `-`，其余只允许
 * `[A-Za-z0-9._-]`，其它码元转 `~XXXX`（大写十六进制 4 位），去掉前导 `-`，
 * 截断到 251 字符，最后包成 `--…--`；cwd 缺失时是 `--_no-cwd--`。
 * 例：`E:\work\demo-project` → `--E-work-demo-project--`；`E:\示例\demo` → `--E-~793A~4F8B-demo--`
 */
function encodeProjectKey(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '--_no-cwd--'
  let out = ''
  let i = 0
  while (i < cwd.length) {
    const ch = cwd[i]
    if (ch === '\\' || ch === '/' || ch === ':') {
      while (i < cwd.length && (cwd[i] === '\\' || cwd[i] === '/' || cwd[i] === ':')) i += 1
      out += '-'
      continue
    }
    if (/[A-Za-z0-9._-]/.test(ch)) out += ch
    else out += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
    i += 1
  }
  out = out.replace(/^-+/, '')
  if (out.length > 251) out = out.slice(0, 251)
  return `--${out}--`
}

function nowIso() {
  return new Date().toISOString()
}

// ───────────────────────────── 插件主体 ─────────────────────────────

export function apply(ctx, config) {
  const HOME = dshHome()
  const SESSIONS_ROOT = path.join(HOME, 'sessions')
  const PROJ_CACHE_DIR = path.join(HOME, 'storages', 'session_projcache', 'sessions')
  const WORKSPACE_JSON = path.join(HOME, 'storages', 'workspace.json')
  const DATA_DIR = path.join(HOME, 'session-manager')
  const TRASH_DIR = path.join(DATA_DIR, 'trash')
  const PENDING_FILE = path.join(DATA_DIR, 'pending.json')
  const LOG_FILE = path.join(DATA_DIR, 'log.jsonl')
  // ── 策略：把"能删什么、删到什么程度"变成显式配置，并在服务端强制执行 ──
  // 摩擦分级依据 GitLab Pajamas 的 destructive actions 规范：
  //   低严重度（可还原）→ 不加摩擦；中/高严重度（不可恢复）→ 弹窗 + 危险按钮，
  //   会连带删除附加资源时要求输入确认词。这里把该规则落成服务端可强制的字段。
  const POLICY = (() => {
    const c = config && typeof config === 'object' ? config : {}
    const bool = (v, d) => (typeof v === 'boolean' ? v : d)
    const int = (v, d, min) => (Number.isFinite(Number(v)) && Math.trunc(Number(v)) >= min ? Math.trunc(Number(v)) : d)
    return {
      enabled: bool(c.enabled, true),
      trashKeepDays: int(c.trashKeepDays, 30, 0),
      allowPurge: bool(c.allowPurge, true),
      allowSubagentDelete: bool(c.allowSubagentDelete, true),
      protectPinned: bool(c.protectPinned, false),
      protectArchived: bool(c.protectArchived, false),
      protectedSessionIds: Array.isArray(c.protectedSessionIds)
        ? c.protectedSessionIds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
        : [],
      maxBatchSize: int(c.maxBatchSize, 50, 1),
      requireTypedConfirmAt: int(c.requireTypedConfirmAt, 3, 1),
      purgeConfirmWord: typeof c.purgeConfirmWord === 'string' && c.purgeConfirmWord.trim() ? c.purgeConfirmWord.trim() : 'PURGE',
    }
  })()
  const keepDays = POLICY.trashKeepDays

  /** 策略拒绝 → HTTP 错误。集中在一处，保证错误码与文案不漂移。 */
  const POLICY_MESSAGES = {
    disabled: '插件已被配置为只读（enabled: false），任何删除都被拒绝',
    'purge-disabled': '配置中已禁用彻底删除（allowPurge: false）',
    protected: '这条会话在 protectedSessionIds 名单里，永不允许删除',
    'subagent-protected': '配置中禁止删除子代理会话（allowSubagentDelete: false）',
    'pinned-protected': '这条会话已置顶；请先取消置顶（protectPinned: true）',
    'archived-protected': '这条会话已归档；请先取消归档（protectArchived: true）',
    orphan: '这个回收站条目没有可读的 meta.json，无法归属到具体会话，已拒绝处理（保守）',
  }
  function throwPolicy(code) {
    throw new HttpError(code === 'disabled' || code === 'orphan' ? 403 : 403, code, POLICY_MESSAGES[code] ?? code)
  }

  function assertEnabled() {
    if (!POLICY.enabled) throwPolicy('disabled')
  }

  /** 与"删哪条"有关的策略判定（不含活跃判定，也不含彻底删除那条）。 */
  function policyBlockForId(id, meta) {
    if (!POLICY.enabled) return 'disabled'
    if (POLICY.protectedSessionIds.includes(id)) return 'protected'
    if (sessionKind(id) === 'subagent' && !POLICY.allowSubagentDelete) return 'subagent-protected'
    if (meta && meta.pinned && POLICY.protectPinned) return 'pinned-protected'
    if (meta && meta.archived && POLICY.protectArchived) return 'archived-protected'
    return null
  }

  /**
   * 回收站条目能不能被彻底删除。
   * 注意：进回收站时已把置顶/归档引用摘掉了，所以这里只能判"与条目身份有关"的策略
   * （只读、禁止彻底删除、名单、子代理）。没有 meta 的条目一律不动（保守）。
   */
  function trashPolicyRejection(meta) {
    if (!POLICY.enabled) return 'disabled'
    if (!POLICY.allowPurge) return 'purge-disabled'
    const id = meta && typeof meta.sessionId === 'string' ? meta.sessionId : ''
    if (!id) return 'orphan'
    if (POLICY.protectedSessionIds.includes(id)) return 'protected'
    if (sessionKind(id) === 'subagent' && !POLICY.allowSubagentDelete) return 'subagent-protected'
    return null
  }

  /** 彻底删除的前置闸门：与具体会话无关的那两条策略，先于一切参数校验。 */
  function assertPurgeAllowed() {
    assertEnabled()
    if (!POLICY.allowPurge) throwPolicy('purge-disabled')
  }

  /** 删除前的策略闸门：任何一条不满足都拒绝，并给出可读原因。 */
  function assertPolicy(id, { forPurge = false, meta = null } = {}) {
    if (forPurge) assertPurgeAllowed()
    else assertEnabled()
    const code = policyBlockForId(id, meta)
    if (code) throwPolicy(code)
  }

  /** 排队（重启后删除）也要过策略：否则会在队列里堆一批永远删不掉的条目。 */
  function assertQueueable(id) {
    assertEnabled()
    const index = readIndex()
    const code = policyBlockForId(id, {
      pinned: index.pinned.includes(id),
      archived: index.archived.includes(id),
    })
    if (code) throwPolicy(code)
  }

  /** 批量请求的通用校验：非空、不超上限、确认数量必须与实际条数一致。 */
  function assertBatch(list, confirmCount, label) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new HttpError(400, 'empty', `${label}：列表不能为空`)
    }
    if (list.length > POLICY.maxBatchSize) {
      throw new HttpError(413, 'too-many', `${label}：单次最多 ${POLICY.maxBatchSize} 条（maxBatchSize）`)
    }
    if (confirmCount !== undefined && Number(confirmCount) !== list.length) {
      throw new HttpError(
        400,
        'confirm-mismatch',
        `${label}：确认数量与实际不一致（收到 ${confirmCount}，实际 ${list.length} 条）`,
      )
    }
  }

  /** 不可恢复的操作要求输入确认词；条数达到阈值才强制，阈值以下由界面用两步确认兜住。 */
  function assertTypedConfirm(typedConfirm, count, label) {
    if (count < POLICY.requireTypedConfirmAt) return
    if (String(typedConfirm ?? '') !== POLICY.purgeConfirmWord) {
      throw new HttpError(400, 'confirm-word', `${label}：需要输入确认词 ${POLICY.purgeConfirmWord}`)
    }
  }

  const disposers = []
  const log = (entry) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.appendFileSync(LOG_FILE, `${JSON.stringify({ at: nowIso(), ...entry })}\n`, 'utf8')
    } catch {
      /* 审计日志失败不能影响主流程 */
    }
  }

  // ── 活跃会话（权威判据，且 fail-closed）──────────────────────────
  // 会话服务走"可选 fiber"：就绪则自动接上，缺席也不会挡住插件激活。
  let sessionsSvc = null
  const sessionsService = () => {
    if (sessionsSvc) return sessionsSvc
    try {
      return ctx.get('sessions') ?? null
    } catch {
      return null
    }
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessions'], (sessionCtx) => {
        try {
          sessionsSvc = sessionCtx.get('sessions') ?? sessionCtx.sessions ?? null
        } catch {
          sessionsSvc = null
        }
        return () => {
          sessionsSvc = null
        }
      })
    }
  } catch {
    /* 该内核不接受可选 fiber 时，退化为每次 ctx.get */
  }

  // 内核没有"活跃会话服务"，可用的是会话 store 本身：`ctx.sessions.get(id)` 非空即
  // 进程内存在 live session —— 删一条这样的会话会被写句柄立刻重建，必须拒绝。
  // 判不出来时返回 'unknown'，调用方按"不许删"处理（宁可拒绝，不可误删）。
  function liveness(id) {
    const sessions = sessionsService()
    if (sessions) {
      if (typeof sessions.get === 'function') {
        try {
          return sessions.get(id) ? 'live' : 'free'
        } catch {
          /* 落到 list */
        }
      }
      if (typeof sessions.list === 'function') {
        try {
          const list = sessions.list()
          if (Array.isArray(list)) {
            const hit = list.some((s) => s && (s.id ?? s.sessionId ?? s.session_id) === id)
            return hit ? 'live' : 'free'
          }
        } catch {
          /* 落到 unknown */
        }
      }
      return 'unknown'
    }
    // 会话服务不可用：用 agent 注册表兜底（持有 agent 的会话同样在被使用）
    try {
      const agents = ctx.get('agents')
      if (agents && typeof agents.get === 'function') return agents.get(id) ? 'live' : 'free'
    } catch {
      /* ignore */
    }
    return 'unknown'
  }

  const liveIdSet = () => {
    const set = new Set()
    try {
      const sessions = sessionsService()
      if (sessions && typeof sessions.list === 'function') {
        const list = sessions.list()
        if (Array.isArray(list)) {
          for (const s of list) {
            const id = s && (s.id ?? s.sessionId ?? s.session_id)
            if (typeof id === 'string' && id) set.add(id)
          }
        }
      }
    } catch {
      /* ignore */
    }
    return set
  }

  /** 删除前的硬闸门：'free' 才放行 */
  const assertDeletable = (id) => {
    const state = liveness(id)
    if (state === 'live') {
      throw new HttpError(409, 'live', '这条会话正在使用中，先切换到别的会话，或排入重启后删除')
    }
    if (state === 'unknown') {
      throw new HttpError(
        409,
        'live-unknown',
        '无法确认这条会话是否正在使用（内核会话服务读数不可用），为避免误删已拒绝；可改用"排入重启后删除"',
      )
    }
  }

  /**
   * 额外问一次内核自己的"这条会话还有什么在跑"（回合 / 后台任务 / 子代理 / 定时任务）。
   * 有信息且非空 → 视为活跃；问不到（事件未声明、API 形态不同）→ 返回 null，不影响主判据。
   */
  async function runningActivity(id) {
    try {
      if (typeof ctx.waterfall !== 'function') return null
      const out = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
      if (Array.isArray(out)) return out
      return out ? [out] : null
    } catch {
      return null
    }
  }

  // ── 索引：workspace.json ────────────────────────────────────────
  const readIndex = () => {
    const doc = readJsonSafe(WORKSPACE_JSON)
    const out = { doc, workspaces: [], archived: [], pinned: [] }
    if (!doc || typeof doc !== 'object') return out
    const g = doc.global ?? {}
    out.archived = Array.isArray(g.archivedSessionIds) ? g.archivedSessionIds.map(String) : []
    out.pinned = Array.isArray(g.pinnedSessionIds) ? g.pinnedSessionIds.map(String) : []
    const table = doc.tables?.workspaces
    if (table && typeof table === 'object') {
      for (const [id, w] of Object.entries(table)) {
        if (!w || typeof w !== 'object') continue
        out.workspaces.push({
          id,
          path: typeof w.path === 'string' ? w.path : '',
          title: typeof w.title === 'string' ? w.title : '',
          sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.map(String) : [],
        })
      }
    }
    return out
  }

  /**
   * 深度摘除引用：数组删元素、标量字段置 null、以 id 为键的映射项整条删除。
   * 不依赖字段名，内核将来新增字段也不会漏。
   */
  function stripIdDeep(node, ids) {
    if (node === null || node === undefined) return node
    if (typeof node === 'string') return node
    if (Array.isArray(node)) {
      const out = []
      for (const item of node) {
        if (typeof item === 'string' && ids.has(item)) continue
        out.push(stripIdDeep(item, ids))
      }
      return out
    }
    if (typeof node === 'object') {
      const out = {}
      for (const [key, value] of Object.entries(node)) {
        if (ids.has(key)) continue
        if (typeof value === 'string' && ids.has(value)) {
          out[key] = null
          continue
        }
        out[key] = stripIdDeep(value, ids)
      }
      return out
    }
    return node
  }

  function rewriteWorkspaceJson(mutate) {
    const raw = (() => {
      try {
        return fs.readFileSync(WORKSPACE_JSON, 'utf8')
      } catch {
        return null
      }
    })()
    if (raw === null) return { changed: false, reason: 'workspace.json 不存在' }
    let doc
    try {
      doc = JSON.parse(raw)
    } catch {
      return { changed: false, reason: 'workspace.json 不是合法 JSON，已跳过' }
    }
    const { changed } = mutate(doc)
    if (!changed) return { changed: false }
    const json = JSON.stringify(doc, null, 2)
    try {
      JSON.parse(json)
    } catch {
      return { changed: false, reason: '重写后校验失败，已放弃写入' }
    }
    try {
      fs.copyFileSync(WORKSPACE_JSON, `${WORKSPACE_JSON}.dsh-delete-guard.bak`)
    } catch {
      /* 备份失败不阻止 */
    }
    writeJsonAtomic(WORKSPACE_JSON, JSON.parse(json))
    return { changed: true }
  }

  const removeRefs = (ids) => {
    const set = new Set(ids)
    return rewriteWorkspaceJson((doc) => {
      let changed = false
      const before = JSON.stringify(doc)
      const next = stripIdDeep(doc, set)
      Object.keys(doc).forEach((k) => delete doc[k])
      Object.assign(doc, next)
      const g = doc.global
      if (g && typeof g === 'object') {
        if (Array.isArray(g.archivedSessionIds)) g.archivedSessionIds = g.archivedSessionIds.filter((x) => !set.has(String(x)))
        if (Array.isArray(g.pinnedSessionIds)) g.pinnedSessionIds = g.pinnedSessionIds.filter((x) => !set.has(String(x)))
      }
      changed = JSON.stringify(doc) !== before
      return { changed }
    })
  }

  const addRefBack = (sessionId, workspaceId) => {
    if (!workspaceId) return { changed: false }
    return rewriteWorkspaceJson((doc) => {
      const w = doc.tables?.workspaces?.[workspaceId]
      if (!w || typeof w !== 'object') return { changed: false }
      if (!Array.isArray(w.sessionIds)) w.sessionIds = []
      if (w.sessionIds.includes(sessionId)) return { changed: false }
      w.sessionIds.push(sessionId)
      w.updatedAt = nowIso()
      return { changed: true }
    })
  }

  // ── 会话枚举 ────────────────────────────────────────────────────
  const workspaceSlugsOnDisk = () => {
    try {
      return fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
  }

  function sessionDirOf(id) {
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) {
      throw new HttpError(400, 'bad-id', '会话 id 不合法')
    }
    for (const slug of workspaceSlugsOnDisk()) {
      const dir = path.join(SESSIONS_ROOT, slug, id)
      if (isDirectory(dir) && looksLikeSessionDir(dir)) return { dir, slug }
    }
    return null
  }

  function projectTitle(id) {
    const rec = readJsonSafe(path.join(PROJ_CACHE_DIR, `${id}.json`))
    const row = rec?.record?.rows?.title
    const title = row && typeof row.val === 'string' ? row.val : ''
    const cwd = rec?.record?.identity?.cwd
    return { title, cwd: typeof cwd === 'string' ? cwd : '' }
  }

  function listSessions() {
    const index = readIndex()
    const byPath = new Map()
    for (const w of index.workspaces) {
      if (w.path) byPath.set(encodeProjectKey(w.path).toLowerCase(), w)
    }
    const sessions = []
    for (const slug of workspaceSlugsOnDisk()) {
      const wsDir = path.join(SESSIONS_ROOT, slug)
      let entries = []
      try {
        entries = fs.readdirSync(wsDir, { withFileTypes: true })
      } catch {
        continue
      }
      const ws = byPath.get(slug.toLowerCase()) ?? null
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const id = e.name
        if (!ANY_SESSION_ID_RE.test(id)) continue
        const dir = path.join(wsDir, id)
        if (!looksLikeSessionDir(dir)) continue
        const { bytes, updatedAt } = dirBytes(dir)
        const meta = projectTitle(id)
        const state = liveness(id)
        const kind = sessionKind(id)
        // 服务端算好"为什么不能删"，界面只负责展示（单一事实来源）。
        // 活跃/无法判定优先展示（动态事实），其余交给策略判定，避免两处各写一套条件。
        const blockedReason =
          state !== 'free'
            ? state
            : policyBlockForId(id, {
                pinned: index.pinned.includes(id),
                archived: index.archived.includes(id),
              })
        sessions.push({
          id,
          kind,
          blockedReason,
          deletable: blockedReason === null,
          bytes,
          updatedAt,
          title: meta.title,
          workspacePath: ws?.path ?? meta.cwd ?? '',
          workspaceTitle: ws?.title ?? '',
          workspaceId: ws?.id ?? '',
          listed: ws ? ws.sessionIds.includes(id) : false,
          archived: index.archived.includes(id),
          pinned: index.pinned.includes(id),
          liveness: state,
          // 保守展示：判不出来也按"使用中"呈现，避免用户以为能直接删
          live: state !== 'free',
          inTrash: false,
        })
      }
    }
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return { index, sessions }
  }

  // ── 回收站 ──────────────────────────────────────────────────────
  function trashEntries() {
    let entries = []
    try {
      entries = fs.readdirSync(TRASH_DIR, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const dir = path.join(TRASH_DIR, e.name)
      const meta = readJsonSafe(path.join(dir, 'meta.json'))
      if (!meta || typeof meta !== 'object') continue
      out.push({ entryId: e.name, dir, ...meta })
    }
    out.sort((a, b) => String(b.deletedAt ?? '').localeCompare(String(a.deletedAt ?? '')))
    return out
  }

  function readPending() {
    const doc = readJsonSafe(PENDING_FILE)
    return Array.isArray(doc) ? doc.filter((x) => x && typeof x.sessionId === 'string') : []
  }
  const writePending = (list) => writeJsonAtomic(PENDING_FILE, list)

  // ── 删除：移入回收站（同一卷 rename，原子）──────────────────────
  function moveToTrash(id, { reason = 'manual' } = {}) {
    const found = sessionDirOf(id)
    if (!found) throw new HttpError(404, 'not-found', '这条会话在磁盘上不存在（可能已被删除）')
    const meta0 = projectTitle(id)
    const index = readIndex()
    const ws = index.workspaces.find((w) => w.path && encodeProjectKey(w.path).toLowerCase() === found.slug.toLowerCase()) ?? null
    assertPolicy(id, {
      meta: { pinned: index.pinned.includes(id), archived: index.archived.includes(id) },
    })
    assertDeletable(id)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const entryId = `${stamp}_${id}`
    const entryDir = path.join(TRASH_DIR, entryId)
    fs.mkdirSync(entryDir, { recursive: true })

    const { bytes } = dirBytes(found.dir)
    // 投影缓存主文件，以及内核 schema 失败时留下的 `<id>.json.bak.<stamp>` 残留
    const projectionFiles = (() => {
      try {
        return fs
          .readdirSync(PROJ_CACHE_DIR)
          .filter((name) => name === `${id}.json` || name.startsWith(`${id}.json.bak`))
          .map((name) => ({ name, from: path.join(PROJ_CACHE_DIR, name) }))
      } catch {
        return []
      }
    })()
    const projectionDir = path.join(entryDir, 'projection')

    // **先写 meta 再搬文件**：条目在任何时刻都可归属、可做策略判定。
    // 反过来（先搬后写）一旦在两步之间崩溃，就会留下一个"有正文却无人认领"的目录，
    // 既不能还原，也无法判定它是否受保护。
    const metaDoc = {
      entryId,
      sessionId: id,
      title: meta0.title,
      workspaceSlug: found.slug,
      workspaceId: ws?.id ?? '',
      workspacePath: ws?.path ?? meta0.cwd ?? '',
      originalPath: found.dir,
      projectionFiles,
      deletedAt: nowIso(),
      bytes,
      reason,
      keepDays,
      complete: false,
    }
    const metaPath = path.join(entryDir, 'meta.json')
    writeJsonAtomic(metaPath, metaDoc)

    try {
      fs.renameSync(found.dir, path.join(entryDir, 'payload'))
      if (projectionFiles.length) fs.mkdirSync(projectionDir, { recursive: true })
      for (const file of projectionFiles) fs.renameSync(file.from, path.join(projectionDir, file.name))
    } catch (err) {
      // 回滚：尽量把已经移动的部分放回去；什么都没搬成时把空条目目录也清掉
      let rolledBack = true
      try {
        if (!isDirectory(found.dir) && isDirectory(path.join(entryDir, 'payload'))) {
          fs.renameSync(path.join(entryDir, 'payload'), found.dir)
        }
        for (const file of projectionFiles) {
          const moved = path.join(projectionDir, file.name)
          if (!fs.existsSync(file.from) && fs.existsSync(moved)) fs.renameSync(moved, file.from)
        }
      } catch {
        rolledBack = false
      }
      if (rolledBack) {
        try {
          fs.rmSync(entryDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
      log({ action: 'trash-failed', sessionId: id, entryId, rolledBack, error: String(err?.message ?? err) })
      throw new HttpError(500, 'move-failed', `移入回收站失败：${String(err?.message ?? err)}`)
    }

    // 搬完才标成 complete；崩溃留下的 complete:false 条目仍可归属、可策略判定
    writeJsonAtomic(metaPath, { ...metaDoc, complete: true })

    const refs = removeRefs([id])
    // 排队表里也不该再留这条
    const pending = readPending().filter((x) => x.sessionId !== id)
    writePending(pending)

    log({ action: 'trash', sessionId: id, entryId, bytes, refs, reason })
    return { entryId, bytes, refs: refs.changed === true }
  }

  function restore(entryId) {
    if (typeof entryId !== 'string' || entryId.includes('/') || entryId.includes('\\') || entryId.includes('..')) {
      throw new HttpError(400, 'bad-entry', '回收站条目 id 不合法')
    }
    const dir = path.join(TRASH_DIR, entryId)
    const meta = readJsonSafe(path.join(dir, 'meta.json'))
    if (!meta) throw new HttpError(404, 'not-found', '回收站里没有这个条目')
    const payload = path.join(dir, 'payload')
    if (!isDirectory(payload)) throw new HttpError(500, 'broken', '回收站条目缺少正文，无法还原')

    // 严格校验还原目标：meta.json 是磁盘上的普通文件，可能被外部改动。
    // 只允许写回 <会话根>/<工作区>/<会话id> 这个形状，其它一律拒绝。
    const original = typeof meta.originalPath === 'string' ? path.resolve(meta.originalPath) : ''
    const rel = original ? path.relative(path.resolve(SESSIONS_ROOT), original) : ''
    const segments = rel ? rel.split(path.sep) : []
    const validOriginal =
      original !== '' &&
      ANY_SESSION_ID_RE.test(String(meta.sessionId ?? '')) &&
      path.basename(original) === meta.sessionId &&
      segments.length === 2 &&
      !segments.some((s) => s === '' || s === '..' || s === '.')
    if (!validOriginal) {
      throw new HttpError(409, 'bad-meta', '回收站条目记录的原路径不在会话根目录内，已拒绝还原')
    }
    if (isDirectory(original)) {
      throw new HttpError(409, 'occupied', '原位置已经有同名会话目录，未做还原')
    }
    fs.mkdirSync(path.dirname(original), { recursive: true })
    fs.renameSync(payload, original)
    // 投影缓存（主文件与 .bak 残留）回到原位；失败不致命，它会按需重建
    const projectionDir = path.join(dir, 'projection')
    const projections = Array.isArray(meta.projectionFiles) ? meta.projectionFiles : []
    if (!projections.length && meta.projectionPath) {
      // 兼容更早版本写下的 meta
      projections.push({ name: 'projection.json', from: meta.projectionPath })
    }
    for (const file of projections) {
      try {
        // 同理：只允许写回投影缓存目录本身，且文件名必须属于这条会话
        const target = typeof file.from === 'string' ? path.resolve(file.from) : ''
        const targetRel = target ? path.relative(path.resolve(PROJ_CACHE_DIR), target) : ''
        if (!target || targetRel.includes(path.sep) || !targetRel.startsWith(`${meta.sessionId}.json`)) continue
        const from = path.join(projectionDir, path.basename(target))
        if (!fs.existsSync(from)) continue
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.renameSync(from, target)
      } catch {
        /* ignore */
      }
    }
    const refs = addRefBack(meta.sessionId, meta.workspaceId)
    fs.rmSync(dir, { recursive: true, force: true })
    log({ action: 'restore', sessionId: meta.sessionId, entryId, refs })
    return { sessionId: meta.sessionId, refs: refs.changed === true }
  }

  function purge(entryId) {
    if (typeof entryId !== 'string' || entryId.includes('/') || entryId.includes('\\') || entryId.includes('..')) {
      throw new HttpError(400, 'bad-entry', '回收站条目 id 不合法')
    }
    const dir = path.join(TRASH_DIR, entryId)
    if (!isDirectory(dir)) throw new HttpError(404, 'not-found', '回收站里没有这个条目')
    const meta = readJsonSafe(path.join(dir, 'meta.json'))
    // 与"清空回收站"用同一个判定函数：单条与批量不可能出现语义分叉
    const code = trashPolicyRejection(meta)
    if (code) throwPolicy(code)
    fs.rmSync(dir, { recursive: true, force: true })
    log({ action: 'purge', entryId, sessionId: meta?.sessionId ?? '' })
    return { entryId }
  }

  function purgeAll(confirmCount, typedConfirm) {
    // 策略优先于参数校验：配置禁止彻底删除时报"策略禁止"，而不是被"条数过期"掩盖
    assertPurgeAllowed()
    const listed = trashEntries()
    const names = (() => {
      try {
        return fs
          .readdirSync(TRASH_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        return []
      }
    })()
    if (listed.length === 0 && names.length === 0) throw new HttpError(409, 'empty-trash', '回收站已经是空的')
    // TOCTOU 防护：界面看到几条就只允许清几条，期间回收站变了就要求刷新
    if (Number(confirmCount) !== listed.length) {
      throw new HttpError(
        409,
        'stale',
        `回收站内容已变化（界面显示 ${confirmCount} 条，实际 ${listed.length} 条），请刷新后重试`,
      )
    }
    // 清空回收站属于高严重度、不可恢复：无论几条都必须输入确认词
    if (String(typedConfirm ?? '') !== POLICY.purgeConfirmWord) {
      throw new HttpError(400, 'confirm-word', `清空回收站：需要输入确认词 ${POLICY.purgeConfirmWord}`)
    }
    // 逐条过策略：受保护条目与无法归属的残留一律不动（保持与单条彻底删除完全一致的语义）
    const byName = new Map(listed.map((entry) => [entry.entryId, entry]))
    const skipped = []
    let count = 0
    for (const name of names) {
      const entry = byName.get(name)
      const code = trashPolicyRejection(entry ?? null)
      if (code) {
        skipped.push({ entryId: name, sessionId: entry?.sessionId ?? '', code })
        continue
      }
      try {
        fs.rmSync(path.join(TRASH_DIR, name), { recursive: true, force: true })
        count += 1
      } catch (err) {
        skipped.push({ entryId: name, sessionId: entry?.sessionId ?? '', code: 'error', error: String(err?.message ?? err) })
      }
    }
    log({ action: 'purge-all', count, skipped: skipped.length, skippedCodes: skipped.map((s) => s.code) })
    return { count, skipped }
  }

  /** 批量删除：逐条独立结算，被策略或活跃判定拦下的条目不会拖垮其它条目。 */
  function batchTrash(ids, confirmCount) {
    // 只读模式属于"整体不允许"，直接顶层拒绝，而不是返回一堆逐条失败
    assertEnabled()
    assertBatch(ids, confirmCount, '批量删除')
    const results = []
    for (const raw of ids) {
      const id = String(raw)
      try {
        const res = moveToTrash(id, { reason: 'batch' })
        results.push({ id, ok: true, entryId: res.entryId, bytes: res.bytes })
      } catch (err) {
        results.push({
          id,
          ok: false,
          code: err instanceof HttpError ? err.code : 'error',
          error: String(err?.message ?? err),
        })
      }
    }
    const ok = results.filter((r) => r.ok).length
    log({ action: 'trash-batch', requested: ids.length, ok, failed: ids.length - ok })
    return { results, ok, failed: ids.length - ok }
  }

  function batchRestore(entryIds) {
    assertBatch(entryIds, undefined, '批量还原')
    const results = []
    for (const raw of entryIds) {
      const entryId = String(raw)
      try {
        const res = restore(entryId)
        results.push({ entryId, ok: true, sessionId: res.sessionId })
      } catch (err) {
        results.push({
          entryId,
          ok: false,
          code: err instanceof HttpError ? err.code : 'error',
          error: String(err?.message ?? err),
        })
      }
    }
    const ok = results.filter((r) => r.ok).length
    log({ action: 'restore-batch', requested: entryIds.length, ok, failed: entryIds.length - ok })
    return { results, ok, failed: entryIds.length - ok }
  }

  function batchPurge(entryIds, confirmCount, typedConfirm) {
    assertPurgeAllowed()
    assertBatch(entryIds, confirmCount, '批量彻底删除')
    assertTypedConfirm(typedConfirm, entryIds.length, '批量彻底删除')
    const results = []
    for (const raw of entryIds) {
      const entryId = String(raw)
      try {
        purge(entryId)
        results.push({ entryId, ok: true })
      } catch (err) {
        results.push({
          entryId,
          ok: false,
          code: err instanceof HttpError ? err.code : 'error',
          error: String(err?.message ?? err),
        })
      }
    }
    const ok = results.filter((r) => r.ok).length
    log({ action: 'purge-batch', requested: entryIds.length, ok, failed: entryIds.length - ok })
    return { results, ok, failed: entryIds.length - ok }
  }

  // ── 排队：重启后（不再活跃时）执行 ──────────────────────────────
  function queue(id) {
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) throw new HttpError(400, 'bad-id', '会话 id 不合法')
    // 排队也过策略：否则队列里会堆一批永远删不掉的条目（每次都白跑一遍）
    assertQueueable(id)
    const list = readPending()
    if (!list.some((x) => x.sessionId === id)) {
      list.push({ sessionId: id, requestedAt: nowIso(), reason: 'queued-while-live' })
      writePending(list)
      log({ action: 'queue', sessionId: id })
    }
    return { sessionId: id }
  }
  function unqueue(id) {
    const list = readPending()
    const next = list.filter((x) => x.sessionId !== id)
    writePending(next)
    log({ action: 'unqueue', sessionId: id })
    return { sessionId: id }
  }

  const pendingReport = []
  function processPending() {
    let list = readPending()
    if (!list.length) return
    const keep = []
    for (const item of list) {
      const id = item.sessionId
      try {
        const state = liveness(id)
        if (state !== 'free') {
          // live 或 unknown 都保留在队列里，下次启动再试（宁可晚删，不可误删）
          keep.push(item)
          pendingReport.push({ sessionId: id, result: state === 'live' ? 'still-live' : 'liveness-unknown' })
          continue
        }
        if (!sessionDirOf(id)) {
          pendingReport.push({ sessionId: id, result: 'already-gone' })
          continue
        }
        const res = moveToTrash(id, { reason: 'pending-at-startup' })
        pendingReport.push({ sessionId: id, result: 'trashed', entryId: res.entryId })
      } catch (err) {
        const code = err instanceof HttpError ? err.code : ''
        // 永久性拒绝（策略问题）不该每启动一次重试一次：丢弃并如实报告；
        // 只有"这次不行、下次可能行"的原因（活跃 / 读不到活跃状态）才留在队列里。
        const permanent = [
          'disabled',
          'purge-disabled',
          'protected',
          'subagent-protected',
          'pinned-protected',
          'archived-protected',
          'bad-id',
        ].includes(code)
        if (!permanent) keep.push(item)
        pendingReport.push({
          sessionId: id,
          result: permanent ? 'dropped' : 'failed',
          code,
          error: String(err?.message ?? err),
        })
      }
    }
    writePending(keep)
    log({ action: 'process-pending', results: pendingReport })
  }

  // ── HTTP 信任围栏 ───────────────────────────────────────────────
  const isLoopbackHostname = (hostname) => {
    const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (!h) return false
    if (h === 'localhost' || h.endsWith('.localhost')) return true
    if (h === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
    if (!m) return false
    if (Number(m[1]) !== 127) return false
    return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
  }

  const deny = (res, status) => {
    try {
      res.writeHead(status || 403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
    } catch {
      /* ignore */
    }
    return true
  }

  let fenceWarned = false
  function connectionFence() {
    try {
      const conn = ctx.get('connection') ?? ctx.connection
      return conn && typeof conn.requestRejection === 'function' ? conn : null
    } catch {
      return null
    }
  }

  /** 通过 → false；拒绝 → true（已写好响应） */
  function rejected(req, res) {
    try {
      const headers = req.headers ?? {}
      let hostUrl = null
      try {
        hostUrl = new URL(`http://${String(headers.host ?? '')}`)
      } catch {
        return deny(res, 403)
      }
      if (!isLoopbackHostname(hostUrl.hostname)) return deny(res, 403)
      const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
      if (site === 'cross-site') return deny(res, 403)
      const origin = headers.origin
      if (typeof origin === 'string' && origin && origin !== 'null') {
        let originUrl = null
        try {
          originUrl = new URL(origin)
        } catch {
          return deny(res, 403)
        }
        if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny(res, 403)
      }
      const conn = connectionFence()
      if (!conn) {
        if (!fenceWarned) {
          fenceWarned = true
          log({ action: 'fence-fallback', note: '宿主 connection 栅栏不可用，使用插件自带回环/同源校验' })
        }
        return false
      }
      let code
      try {
        code = conn.requestRejection(req)
      } catch {
        return deny(res, 403)
      }
      if (code === undefined || code === null || code === false) return false
      return deny(res, typeof code === 'number' ? code : 403)
    } catch {
      return deny(res, 403)
    }
  }

  const sendJson = (res, status, payload) => {
    const body = JSON.stringify(payload)
    try {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(Buffer.byteLength(body)),
      })
      res.end(body)
    } catch {
      /* ignore */
    }
  }

  const readJsonBody = (req, limit = 256 * 1024) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new HttpError(413, 'too-large', '请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (!chunks.length) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new HttpError(400, 'bad-json', '请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })

  function register(pathname, handler) {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        try {
          await handler(req, res)
        } catch (err) {
          const status = err instanceof HttpError ? err.status : 500
          const code = err instanceof HttpError ? err.code : 'internal'
          if (!(err instanceof HttpError)) log({ action: 'error', path: pathname, error: String(err?.stack ?? err) })
          sendJson(res, status, { ok: false, code, error: String(err?.message ?? err) })
        }
      },
    })
    disposers.push(dispose)
    return dispose
  }

  const wantMethod = (req, res, method) => {
    if (String(req.method ?? 'GET').toUpperCase() === method) return true
    sendJson(res, 405, { ok: false, code: 'method', error: `需要 ${method}` })
    return false
  }

  // ── 路由 ────────────────────────────────────────────────────────
  register(`${ROUTE_PREFIX}/list`, async (req, res) => {
    if (!wantMethod(req, res, 'GET')) return
    const { sessions } = listSessions()
    const trash = trashEntries().map((t) => ({
      entryId: t.entryId,
      sessionId: t.sessionId,
      title: t.title ?? '',
      workspacePath: t.workspacePath ?? '',
      bytes: t.bytes ?? 0,
      deletedAt: t.deletedAt ?? '',
      reason: t.reason ?? '',
      complete: t.complete !== false,
      // 服务端算好"这条能不能被彻底删除"，界面只负责展示
      purgeBlockedReason: trashPolicyRejection(t),
    }))
    const pending = readPending().map((p) => {
      const meta = projectTitle(p.sessionId)
      return { sessionId: p.sessionId, requestedAt: p.requestedAt ?? '', title: meta.title, live: liveness(p.sessionId) !== 'free' }
    })
    sendJson(res, 200, {
      ok: true,
      dshHome: HOME,
      sessionsRoot: SESSIONS_ROOT,
      dataDir: DATA_DIR,
      logFile: LOG_FILE,
      policy: POLICY,
      counts: {
        sessions: sessions.length,
        trash: trash.length,
        pending: pending.length,
        live: sessions.filter((x) => x.liveness === 'live').length,
        subagent: sessions.filter((x) => x.kind === 'subagent').length,
        blocked: sessions.filter((x) => !x.deletable).length,
      },
      sessions,
      trash,
      pending,
      startup: pendingReport,
      live: [...liveIdSet()],
    })
  })

  register(`${ROUTE_PREFIX}/delete`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const id = String(body.id ?? '')
    // 先问内核"这条会话还有没有正在跑的工作"，再落到文件层
    const activity = await runningActivity(id)
    if (activity && activity.length > 0) {
      throw new HttpError(
        409,
        'active',
        '这条会话仍有正在运行的工作（回合 / 后台任务 / 子代理 / 定时任务），请先停止，或排入重启后删除',
      )
    }
    const result = moveToTrash(id, { reason: 'manual' })
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/queue`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, ...queue(String(body.id ?? '')) })
  })

  register(`${ROUTE_PREFIX}/unqueue`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, ...unqueue(String(body.id ?? '')) })
  })

  register(`${ROUTE_PREFIX}/restore`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, ...restore(String(body.entryId ?? '')) })
  })

  register(`${ROUTE_PREFIX}/purge`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, ...purge(String(body.entryId ?? '')) })
  })

  register(`${ROUTE_PREFIX}/purge-all`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    sendJson(res, 200, { ok: true, ...purgeAll(body.confirmCount, body.typedConfirm) })
  })

  register(`${ROUTE_PREFIX}/delete-batch`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = batchTrash(body.ids, body.confirmCount)
    sendJson(res, 200, { ok: true, policy: POLICY, ...result })
  })

  register(`${ROUTE_PREFIX}/restore-batch`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = batchRestore(body.entryIds)
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/purge-batch`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = batchPurge(body.entryIds, body.confirmCount, body.typedConfirm)
    sendJson(res, 200, { ok: true, ...result })
  })

  ctx.effect(
    () => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    },
    'dsh-delete-guard: routes',
  )

  // ── 回收站按保留期自动清理（磁盘卫生；keepDays<=0 表示永不清理）────
  function sweepTrash() {
    if (!Number.isFinite(keepDays) || keepDays <= 0) return { removed: 0 }
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    let removed = 0
    for (const entry of trashEntries()) {
      const at = Date.parse(String(entry.deletedAt ?? ''))
      if (!Number.isFinite(at) || at >= cutoff) continue
      try {
        fs.rmSync(entry.dir, { recursive: true, force: true })
        removed += 1
      } catch {
        /* ignore */
      }
    }
    if (removed) log({ action: 'sweep-trash', removed, keepDays })
    return { removed }
  }

  // ── 便捷入口：/sessions 斜杠命令（可选服务，缺失不影响插件）────────
  const COMMAND_HELP =
    'sessions: list | trash | delete <sessionId> | delete-batch <id1,id2,…> | queue <sessionId> | unqueue <sessionId> | restore <entryId> | purge <entryId> | purge-all ' +
    POLICY.purgeConfirmWord
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (cmdCtx) => {
        let dispose = () => {}
        try {
          const commands = cmdCtx.get('commands') ?? cmdCtx.commands
          if (!commands || typeof commands.register !== 'function') return dispose
          const line = (rows) => rows.join('\n')
          dispose = commands.register({
            name: 'sessions',
            description: '会话管理：列出、删除（进回收站）、排队、还原',
            input: { hint: 'list | delete <会话id> | restore <回收站条目id> | purge-all' },
            handler: ({ rawInput }) => {
              try {
                const [sub = 'list', arg = ''] = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
                switch (sub) {
                  case 'list': {
                    const { sessions } = listSessions()
                    if (!sessions.length) return { kind: 'success', text: '没有会话。' }
                    return {
                      kind: 'success',
                      text: line(
                        sessions.map(
                          (s) =>
                            `${s.live ? '[使用中] ' : ''}${s.kind === 'subagent' ? '[子代理] ' : ''}${s.title || '(无标题)'} — ${s.id} — ${Math.round(s.bytes / 1024)} KB`,
                        ),
                      ),
                    }
                  }
                  case 'trash': {
                    const trash = trashEntries()
                    if (!trash.length) return { kind: 'success', text: '回收站是空的。' }
                    return {
                      kind: 'success',
                      text: line(trash.map((t) => `${t.title || '(无标题)'} — ${t.sessionId} — ${t.entryId}`)),
                    }
                  }
                  case 'delete': {
                    const res = moveToTrash(arg, { reason: 'command' })
                    return { kind: 'success', text: `已移入回收站：${arg}（条目 ${res.entryId}）` }
                  }
                  case 'delete-batch': {
                    const ids = String(arg).split(',').map((s) => s.trim()).filter(Boolean)
                    const res = batchTrash(ids, ids.length)
                    return {
                      kind: res.failed ? 'error' : 'success',
                      text:
                        `批量删除：成功 ${res.ok} 条，失败 ${res.failed} 条` +
                        (res.failed
                          ? '\n' + res.results.filter((r) => !r.ok).map((r) => `${r.id} — ${r.error}`).join('\n')
                          : ''),
                    }
                  }
                  case 'queue': {
                    queue(arg)
                    return { kind: 'success', text: `已排入重启后删除：${arg}` }
                  }
                  case 'unqueue': {
                    unqueue(arg)
                    return { kind: 'success', text: `已取消排队：${arg}` }
                  }
                  case 'restore': {
                    const res = restore(arg)
                    return { kind: 'success', text: `已还原：${res.sessionId}` }
                  }
                  case 'purge': {
                    purge(arg)
                    return { kind: 'success', text: `已彻底删除：${arg}` }
                  }
                  case 'purge-all': {
                    if (arg !== POLICY.purgeConfirmWord) {
                      return { kind: 'error', text: `清空回收站不可恢复：请执行 /sessions purge-all ${POLICY.purgeConfirmWord}` }
                    }
                    const res = purgeAll(trashEntries().length, arg)
                    return { kind: 'success', text: `回收站已清空（${res.count} 条）` }
                  }
                  default:
                    return { kind: 'error', text: `未知子命令：${sub}\n${COMMAND_HELP}` }
                }
              } catch (err) {
                return { kind: 'error', text: String(err?.message ?? err) }
              }
            },
          })
        } catch (err) {
          log({ action: 'command-register-failed', error: String(err?.message ?? err) })
        }
        return () => {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      })
    }
  } catch {
    /* 该内核不接受可选 fiber 时，只提供界面入口 */
  }

  // ── 启动时：清理过期回收站 + 执行排队的删除（那时它们通常已不再活跃）──
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  } catch {
    /* ignore */
  }
  const runPending = () => {
    try {
      sweepTrash()
    } catch (err) {
      log({ action: 'sweep-trash-failed', error: String(err?.message ?? err) })
    }
    try {
      processPending()
    } catch (err) {
      log({ action: 'process-pending-failed', error: String(err?.message ?? err) })
    }
  }
  runPending()
  const retry = setTimeout(runPending, 4000)
  if (typeof retry.unref === 'function') retry.unref()
  ctx.effect(() => () => clearTimeout(retry), 'dsh-delete-guard: pending retry')

  log({ action: 'apply', dshHome: HOME, keepDays })
}
