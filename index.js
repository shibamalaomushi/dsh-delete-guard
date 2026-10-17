/**
 * dsh-delete-guard —— Host 半身
 *
 * 目标：安全地删除**单条**会话，绝不影响其它会话；默认移入回收站可还原。
 *
 * 0.2.1-rc.2 适配：
 * - Session 根以 `ctx.sessionPersistence.root` 为准（缺失时回退 `<DSH_HOME>/sessions`）；
 * - 不再重实现 projectKey：扫描真实目录，用 Session header 的 cwd 归属工作区；
 * - workspace 引用通过 `ctx.workspaceRegistry` 更新（0.2.1 的 workspace.json 是
 *   storage-json 的 single 单元，外部改写会被内存权威覆盖，且可能损坏领域）；
 * - 后台任务检查使用 0.2.1 仍在的 `workspace/session-activity` waterfall；
 * - 客户端 bundle 继续遵循 dsh.client 的惰性模块约定。
 *
 * 安全模型：
 * - 只允许删除“会话根下的直接子目录”，id 需匹配严格格式，且目录必须真的装着会话日志；
 * - 所有路径先词法校验，再做 realpath/逐层 lstat；拒绝 symlink/junction 祖先；
 * - 默认进回收站；彻底删除需显式调用；自动清理同样经过全部删除策略；
 * - 活跃会话/仍有后台工作的会话一律拒绝；排队执行默认需要用户确认；
 * - 所有写操作要求回环/同源（connection 可用时委托宿主栅栏）；
 * - 全程写审计日志，日志按大小轮转。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  assertNoSymlinkAncestors,
  assertSingleSegment,
  canonicalizeTarget,
  compareKey,
  expandHomePath,
  isPathInside,
  isRealDirectory,
  isSamePath,
  lstatOrNull,
  realpathNative,
  resolveDshHome,
  resolveUnderRoot,
} from './lib/paths.js'

/**
 * 硬依赖只有 web 服务。会话/持久化/工作区/连接/命令服务都用“可选 fiber”接入：
 * 缺失时插件仍激活，但相应能力会明确降级（删除 fail-closed）。
 */
export const inject = ['webServer']

const SESSION_ID_RE = /^session-[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/
const ANY_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,127}$/
const SESSION_LOG_RE = /^session.*\.jsonl(\.zstd)?$/
const ROUTE_PREFIX = '/dsh-delete-guard/api'
const TRASH_ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,219}$/
const MAX_LOG_LINE_BYTES = 64 * 1024
const MAX_JSON_READ_BYTES = 8 * 1024 * 1024

const sessionKind = (id) => (SESSION_ID_RE.test(id) ? 'main' : 'subagent')

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function readJsonSafe(file, limit = MAX_JSON_READ_BYTES) {
  try {
    const stat = fs.statSync(file)
    if (stat.size > limit) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      const fd = fs.openSync(tmp, 'r+')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      /* fsync 不是所有平台都可用；不阻止写入 */
    }
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
}

function nowIso() {
  return new Date().toISOString()
}

function isDirectory(p) {
  return isRealDirectory(p)
}

function looksLikeSessionDir(dir) {
  try {
    return fs.readdirSync(dir).some((name) => SESSION_LOG_RE.test(name))
  } catch {
    return false
  }
}

function sessionDirBytes(dir) {
  let total = 0
  let newest = 0
  const walk = (d, depth) => {
    if (depth > 4) return
    let entries = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const p = path.join(d, entry.name)
      try {
        if (entry.isDirectory()) {
          walk(p, depth + 1)
        } else if (entry.isFile()) {
          const stat = fs.lstatSync(p)
          total += stat.size
          if (stat.mtimeMs > newest) newest = stat.mtimeMs
        }
      } catch {
        /* 忽略单个文件错误；这里只用于展示 */
      }
    }
  }
  walk(dir, 0)
  try {
    const stat = fs.statSync(dir)
    if (stat.mtimeMs > newest) newest = stat.mtimeMs
  } catch {
    /* ignore */
  }
  return { bytes: total, updatedAt: newest || null }
}

function sessionDirMtime(dir) {
  let newest = 0
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const stat = fs.lstatSync(path.join(dir, entry.name))
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    }
    if (!newest) newest = fs.statSync(dir).mtimeMs
  } catch {
    /* ignore */
  }
  return newest || null
}

function safeString(value, limit = 2000) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function logPreview(value, limit = 200) {
  return safeString(value, limit)
}

function sanitizeForLog(entry) {
  const out = { ...entry }
  if (typeof out.error === 'string') out.error = safeString(out.error, 2000)
  if (typeof out.stack === 'string') out.stack = safeString(out.stack, 4000)
  if (Array.isArray(out.results)) {
    out.results = out.results.slice(0, 100).map((row) => ({
      ...row,
      error: row && typeof row.error === 'string' ? safeString(row.error, 500) : row?.error,
    }))
  }
  if (Array.isArray(out.skipped)) out.skipped = out.skipped.slice(0, 100)
  if (Array.isArray(out.pendingReport)) out.pendingReport = out.pendingReport.slice(0, 100)
  return out
}

function parseConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const int = (value, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    const truncated = Math.trunc(number)
    if (truncated < min || truncated > max) return fallback
    return truncated
  }
  const str = (value, fallback) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback
  const pathString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  const protectedSessionIds = Array.isArray(c.protectedSessionIds)
    ? [...new Set(c.protectedSessionIds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))]
    : []
  return {
    enabled: bool(c.enabled, true),
    trashKeepDays: int(c.trashKeepDays, 30, 0, 36500),
    allowPurge: bool(c.allowPurge, true),
    allowSubagentDelete: bool(c.allowSubagentDelete, true),
    protectPinned: bool(c.protectPinned, false),
    protectArchived: bool(c.protectArchived, false),
    protectedSessionIds,
    maxBatchSize: int(c.maxBatchSize, 50, 1, 1000),
    maxPending: int(c.maxPending, 500, 1, 10000),
    requireTypedConfirmAt: int(c.requireTypedConfirmAt, 3, 1, 10000),
    purgeConfirmWord: str(c.purgeConfirmWord, 'PURGE'),
    processPendingOnStartup: bool(c.processPendingOnStartup, false),
    trashSweepIntervalHours: int(c.trashSweepIntervalHours, 6, 0, 24 * 365),
    logMaxBytes: int(c.logMaxBytes, 5 * 1024 * 1024, 0, 1024 * 1024 * 1024),
    logKeepFiles: int(c.logKeepFiles, 3, 1, 10),
    dshHome: pathString(c.dshHome),
    sessionsRoot: pathString(c.sessionsRoot),
  }
}

/**
 * 插件主体。
 */
export function apply(ctx, config) {
  const POLICY = parseConfig(config)
  const keepDays = POLICY.trashKeepDays
  let HOME
  try {
    HOME = resolveDshHome(POLICY.dshHome)
  } catch (error) {
    throw new HttpError(500, 'bad-home', `DSH_HOME 解析失败：${safeString(error?.message ?? error)}`)
  }
  const DATA_DIR = path.join(HOME, 'session-manager')
  const TRASH_DIR = path.join(DATA_DIR, 'trash')
  const PENDING_FILE = path.join(DATA_DIR, 'pending.json')
  const REPAIR_FILE = path.join(DATA_DIR, 'repair.json')
  const LOG_FILE = path.join(DATA_DIR, 'log.jsonl')
  const PROJ_CACHE_DIR = path.join(HOME, 'storages', 'session_projcache', 'sessions')
  const WORKSPACE_JSON = path.join(HOME, 'storages', 'workspace.json')

  const POLICY_MESSAGES = {
    disabled: '插件已被配置为只读（enabled: false），任何删除都被拒绝',
    'purge-disabled': '配置中已禁用彻底删除（allowPurge: false）',
    protected: '这条会话在 protectedSessionIds 名单里，永不允许删除',
    'subagent-protected': '配置中禁止删除子代理会话（allowSubagentDelete: false）',
    'pinned-protected': '这条会话已置顶；请先取消置顶（protectPinned: true）',
    'archived-protected': '这条会话已归档；请先取消归档（protectArchived: true）',
    orphan: '这个回收站条目没有可读/一致的 meta.json，无法归属到具体会话，已拒绝处理（保守）',
    incomplete: '这个回收站条目尚未完成搬移，拒绝清理/还原；请先查看启动恢复报告',
    broken: '这个回收站条目缺少 payload 或已损坏，拒绝自动处理（保守）',
    ambiguous: '会话 id 在多个工作区目录中重复，无法安全判定目标，已拒绝处理',
  }
  function throwPolicy(code) {
    throw new HttpError(403, code, POLICY_MESSAGES[code] ?? code)
  }

  // ── 审计日志 ──────────────────────────────────────────────────
  let logBytes = 0
  let logWriteError = null
  let logRotated = 0
  try {
    logBytes = fs.statSync(LOG_FILE).size
  } catch {
    logBytes = 0
  }
  function rotateLogIfNeeded(extraBytes = 0) {
    if (!POLICY.logMaxBytes || POLICY.logMaxBytes <= 0) return
    if (logBytes + extraBytes <= POLICY.logMaxBytes) return
    const keep = POLICY.logKeepFiles
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
      for (let index = keep - 1; index >= 1; index -= 1) {
        const from = `${LOG_FILE}.${index}`
        const to = `${LOG_FILE}.${index + 1}`
        if (fs.existsSync(from)) {
          try {
            fs.rmSync(to, { force: true })
          } catch {
            /* ignore */
          }
          fs.renameSync(from, to)
        }
      }
      if (fs.existsSync(LOG_FILE)) {
        try {
          fs.rmSync(`${LOG_FILE}.1`, { force: true })
        } catch {
          /* ignore */
        }
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
      }
      logBytes = 0
      logRotated += 1
    } catch (error) {
      logWriteError = safeString(error?.message ?? error)
    }
  }
  function log(entry) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
      const base = { at: nowIso(), action: typeof entry?.action === 'string' ? entry.action : 'event', version: '2.0.0', ...sanitizeForLog(entry ?? {}) }
      let line = JSON.stringify(base)
      if (Buffer.byteLength(line) > MAX_LOG_LINE_BYTES) {
        line = JSON.stringify({
          at: base.at,
          action: base.action,
          version: base.version,
          truncated: true,
          sessionId: base.sessionId,
          entryId: base.entryId,
        })
      }
      rotateLogIfNeeded(Buffer.byteLength(line) + 1)
      fs.appendFileSync(LOG_FILE, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      logBytes += Buffer.byteLength(line) + 1
      logWriteError = null
    } catch (error) {
      logWriteError = safeString(error?.message ?? error)
    }
  }

  // ── 可选服务 ──────────────────────────────────────────────────
  function service(name) {
    try {
      return ctx.get(name) ?? null
    } catch {
      return null
    }
  }
  function getPersistence() {
    return service('sessionPersistence')
  }
  function getWorkspaceRegistry() {
    return service('workspaceRegistry')
  }
  function connectionFence() {
    try {
      const conn = ctx.get('connection') ?? ctx.connection
      return conn && typeof conn.requestRejection === 'function' ? conn : null
    } catch {
      return null
    }
  }

  let sessionsSvc = null
  const sessionsService = () => {
    if (sessionsSvc) return sessionsSvc
    const sessions = service('sessions')
    if (sessions) sessionsSvc = sessions
    return sessions
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
    /* 旧内核不接受可选 fiber */
  }

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
            return list.some((s) => s && (s.id ?? s.sessionId ?? s.session_id) === id) ? 'live' : 'free'
          }
        } catch {
          /* unknown */
        }
      }
      return 'unknown'
    }
    try {
      const agents = service('agents')
      if (agents && typeof agents.get === 'function') return agents.get(id) ? 'live' : 'free'
    } catch {
      /* ignore */
    }
    return 'unknown'
  }

  function liveIdSet() {
    const set = new Set()
    const sessions = sessionsService()
    if (!sessions || typeof sessions.list !== 'function') return set
    try {
      const list = sessions.list()
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = item && (item.id ?? item.sessionId ?? item.session_id)
          if (typeof id === 'string' && id) set.add(id)
        }
      }
    } catch {
      /* ignore */
    }
    return set
  }

  function assertDeletable(id) {
    const state = liveness(id)
    if (state === 'live') {
      throw new HttpError(409, 'live', '这条会话正在使用中，先切换到别的会话，或排入重启后删除')
    }
    if (state === 'unknown') {
      throw new HttpError(
        409,
        'live-unknown',
        '无法确认这条会话是否正在使用（内核会话服务读数不可用），为避免误删已拒绝；可改用“排入重启后删除”',
      )
    }
  }

  let activityUnavailableLogged = false
  async function activityState(id) {
    if (typeof ctx.waterfall !== 'function') return { state: 'unavailable' }
    if (!getWorkspaceRegistry()) return { state: 'unavailable' }
    try {
      const out = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
      if (!Array.isArray(out)) return { state: 'unknown' }
      return out.length > 0 ? { state: 'active', items: out } : { state: 'clear' }
    } catch {
      return { state: 'unknown' }
    }
  }
  async function assertNoActivity(id) {
    const result = await activityState(id)
    if (result.state === 'active') {
      throw new HttpError(
        409,
        'active',
        '这条会话仍有正在运行的工作（回合 / 后台任务 / 子代理 / 定时任务），请先停止，或排入重启后删除',
      )
    }
    if (result.state === 'unknown') {
      throw new HttpError(
        409,
        'activity-unknown',
        '无法读取这条会话的后台任务状态，为避免误删已拒绝；可改用“排入重启后删除”',
      )
    }
    if (result.state === 'unavailable' && !activityUnavailableLogged) {
      activityUnavailableLogged = true
      log({ action: 'activity-unavailable', note: 'workspaceRegistry 不可用，后台任务检查降级为仅 liveness' })
    }
  }

  // ── 路径/根目录 ────────────────────────────────────────────────
  let sessionsRootSource = null
  function resolveSessionsRootInfo() {
    let root
    let source
    if (POLICY.sessionsRoot) {
      root = path.resolve(expandHomePath(POLICY.sessionsRoot))
      source = 'config'
    } else {
      const persistence = getPersistence()
      if (persistence && typeof persistence.root === 'string' && persistence.root.trim()) {
        root = path.resolve(persistence.root)
        source = 'sessionPersistence'
      } else {
        root = path.join(HOME, 'sessions')
        source = 'default'
      }
    }
    let canonical = root
    try {
      if (fs.statSync(root).isDirectory()) canonical = realpathNative(root)
    } catch {
      /* 根目录可能还没创建；保留解析后的绝对路径 */
    }
    sessionsRootSource = source
    return { root: canonical, source }
  }
  function sessionsRoot() {
    return resolveSessionsRootInfo().root
  }

  function assertHomePath(p) {
    if (typeof p !== 'string' || !p) throw new HttpError(500, 'bad-path', '路径配置为空')
    if (!path.isAbsolute(p)) throw new HttpError(500, 'bad-path', `路径不是绝对路径：${p}`)
    return p
  }
  assertHomePath(HOME)

  // ── 策略 ──────────────────────────────────────────────────────
  function assertEnabled() {
    if (!POLICY.enabled) throwPolicy('disabled')
  }
  function policyBlockForId(id, meta) {
    if (!POLICY.enabled) return 'disabled'
    if (POLICY.protectedSessionIds.includes(id)) return 'protected'
    if (sessionKind(id) === 'subagent' && !POLICY.allowSubagentDelete) return 'subagent-protected'
    if (meta && meta.pinned && POLICY.protectPinned) return 'pinned-protected'
    if (meta && meta.archived && POLICY.protectArchived) return 'archived-protected'
    return null
  }
  function trashPolicyRejection(meta) {
    if (!POLICY.enabled) return 'disabled'
    if (!POLICY.allowPurge) return 'purge-disabled'
    if (!meta || typeof meta !== 'object' || typeof meta.sessionId !== 'string' || !meta.sessionId) return 'orphan'
    if (meta.broken === true) return 'broken'
    if (meta.complete === false) return 'incomplete'
    if (POLICY.protectedSessionIds.includes(meta.sessionId)) return 'protected'
    if (sessionKind(meta.sessionId) === 'subagent' && !POLICY.allowSubagentDelete) return 'subagent-protected'
    if (meta.wasArchived === true && POLICY.protectArchived) return 'archived-protected'
    if (meta.wasPinned === true && POLICY.protectPinned) return 'pinned-protected'
    return null
  }
  function assertPolicy(id, { forPurge = false, meta = null } = {}) {
    if (forPurge) {
      assertEnabled()
      if (!POLICY.allowPurge) throwPolicy('purge-disabled')
    } else {
      assertEnabled()
    }
    const code = policyBlockForId(id, meta)
    if (code) throwPolicy(code)
  }
  function assertBatch(list, confirmCount, label) {
    if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'empty', `${label}：列表不能为空`)
    if (list.length > POLICY.maxBatchSize) {
      throw new HttpError(413, 'too-many', `${label}：单次最多 ${POLICY.maxBatchSize} 条（maxBatchSize）`)
    }
    const strings = list.map((value) => String(value))
    if (new Set(strings).size !== strings.length) throw new HttpError(400, 'duplicate', `${label}：列表包含重复项`)
    if (confirmCount !== undefined) {
      const count = Number(confirmCount)
      if (!Number.isInteger(count) || count !== list.length) {
        throw new HttpError(
          400,
          'confirm-mismatch',
          `${label}：确认数量与实际不一致（收到 ${confirmCount}，实际 ${list.length} 条）`,
        )
      }
    }
    return strings
  }
  function assertTypedConfirm(typedConfirm, count, label) {
    if (count < POLICY.requireTypedConfirmAt) return
    if (String(typedConfirm ?? '') !== POLICY.purgeConfirmWord) {
      throw new HttpError(400, 'confirm-word', `${label}：需要输入确认词 ${POLICY.purgeConfirmWord}`)
    }
  }

  // ── 工作区文档（仅无注册表时回退）─────────────────────────────
  function readWorkspaceDocRaw() {
    try {
      const stat = fs.statSync(WORKSPACE_JSON)
      if (stat.size > MAX_JSON_READ_BYTES) return null
      return JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'))
    } catch {
      return null
    }
  }
  const WORKSPACE_SUPPORTED_VERSIONS = new Set([1, 2])
  function validateWorkspaceDoc(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { valid: false, reason: 'not-object' }
    if (!doc.unit || typeof doc.unit !== 'object') return { valid: false, reason: 'missing-unit' }
    if (doc.unit.name !== 'workspace') return { valid: false, reason: 'wrong-unit' }
    if (!Number.isInteger(doc.unit.version) || !WORKSPACE_SUPPORTED_VERSIONS.has(doc.unit.version)) {
      return { valid: false, reason: 'unsupported-version' }
    }
    if (!doc.global || typeof doc.global !== 'object' || Array.isArray(doc.global)) {
      return { valid: false, reason: 'bad-global' }
    }
    if (!doc.tables || typeof doc.tables !== 'object' || !doc.tables.workspaces || typeof doc.tables.workspaces !== 'object') {
      return { valid: false, reason: 'bad-tables' }
    }
    if (doc.global.pendingMutation !== undefined) return { valid: false, reason: 'pending-mutation' }
    return { valid: true }
  }
  function readIndex() {
    const doc = readWorkspaceDocRaw()
    const out = { doc, workspaces: [], archived: [], pinned: [], workspaceIds: [], valid: false, reason: 'missing' }
    if (!doc) return out
    const validation = validateWorkspaceDoc(doc)
    out.valid = validation.valid
    out.reason = validation.reason ?? null
    const global = doc.global && typeof doc.global === 'object' ? doc.global : {}
    out.workspaceIds = Array.isArray(global.workspaceIds) ? global.workspaceIds.map(String) : []
    out.archived = Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds.filter((x) => typeof x === 'string') : []
    out.pinned = Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds.filter((x) => typeof x === 'string') : []
    const table = doc.tables?.workspaces
    if (table && typeof table === 'object') {
      for (const [id, record] of Object.entries(table)) {
        if (!record || typeof record !== 'object') continue
        out.workspaces.push({
          id,
          path: typeof record.path === 'string' ? record.path : '',
          title: typeof record.title === 'string' ? record.title : '',
          sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter((x) => typeof x === 'string') : [],
        })
      }
    }
    return out
  }

  function workspaceSnapshot() {
    const raw = readIndex()
    const registry = getWorkspaceRegistry()
    const warnings = []
    if (registry && typeof registry.list === 'function') {
      try {
        const entities = registry.list()
        if (Array.isArray(entities)) {
          const workspaces = entities.map((workspace) => ({
            id: String(workspace.id ?? ''),
            path: typeof workspace.path === 'string' ? workspace.path : '',
            title: typeof workspace.title === 'string' ? workspace.title : '',
            sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
          }))
          let archived = []
          let pinned = []
          try {
            archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.map(String) : raw.archived
          } catch {
            archived = raw.archived
          }
          try {
            pinned = Array.isArray(registry.pinnedSessionIds) ? registry.pinnedSessionIds.map(String) : raw.pinned
          } catch {
            pinned = raw.pinned
          }
          return {
            source: 'registry',
            registry,
            entities,
            workspaces,
            archived: new Set(archived),
            pinned: new Set(pinned),
            raw,
            warnings,
          }
        }
      } catch (error) {
        warnings.push(`workspaceRegistry 读取失败，降级为 workspace.json：${safeString(error?.message ?? error, 500)}`)
      }
    }
    if (!raw.valid) warnings.push(`workspace.json 不可写/不可识别：${raw.reason}`)
    return {
      source: 'file',
      registry: null,
      entities: [],
      workspaces: raw.workspaces,
      archived: new Set(raw.archived),
      pinned: new Set(raw.pinned),
      raw,
      warnings,
    }
  }

  function canonicalCwd(value) {
    if (typeof value !== 'string' || !value) return ''
    try {
      return compareKey(value)
    } catch {
      return ''
    }
  }
  function findWorkspaceForCwd(cwd, snapshot) {
    const key = canonicalCwd(cwd)
    if (!key) return null
    return snapshot.workspaces.find((workspace) => workspace.path && canonicalCwd(workspace.path) === key) ?? null
  }
  function findWorkspaceForSession(id, snapshot) {
    const rawOwner = snapshot.raw.workspaces.find((workspace) => workspace.sessionIds.includes(id))
    if (rawOwner) {
      return snapshot.workspaces.find((workspace) => workspace.id === rawOwner.id) ?? rawOwner
    }
    return snapshot.workspaces.find((workspace) => workspace.sessionIds.includes(id)) ?? null
  }
  function captureRefs(id, cwd) {
    const snapshot = workspaceSnapshot()
    const owner = findWorkspaceForSession(id, snapshot)
    return {
      snapshot,
      wasListed: Boolean(owner),
      workspaceId: owner?.id ?? '',
      workspacePath: owner?.path ?? cwd ?? '',
      wasArchived: snapshot.archived.has(id),
      wasPinned: snapshot.pinned.has(id),
      warnings: [...snapshot.warnings],
    }
  }

  function assertWorkspaceWritable(doc, reason) {
    const validation = validateWorkspaceDoc(doc)
    if (!validation.valid) throw new HttpError(409, 'workspace-readonly', `workspace.json 不可写（${validation.reason}）`)
    if (reason) throw new HttpError(409, 'workspace-readonly', reason)
  }

  function writeWorkspaceDocAtomic(doc, statBefore) {
    const current = fs.statSync(WORKSPACE_JSON)
    if (statBefore && (current.mtimeMs !== statBefore.mtimeMs || current.size !== statBefore.size)) {
      throw new HttpError(409, 'workspace-changed', 'workspace.json 已被宿主更新，已放弃本次写入')
    }
    const fileStat = lstatOrNull(WORKSPACE_JSON)
    if (fileStat?.isSymbolicLink()) throw new HttpError(409, 'workspace-readonly', 'workspace.json 是符号链接，拒绝写入')
    const backup = `${WORKSPACE_JSON}.dsh-delete-guard.bak`
    try {
      fs.copyFileSync(WORKSPACE_JSON, backup)
    } catch (error) {
      throw new HttpError(500, 'workspace-backup', `无法备份 workspace.json：${safeString(error?.message ?? error)}`)
    }
    writeJsonAtomic(WORKSPACE_JSON, doc)
    const verify = readWorkspaceDocRaw()
    const validation = validateWorkspaceDoc(verify)
    if (!validation.valid) {
      try {
        fs.copyFileSync(backup, WORKSPACE_JSON)
      } catch {
        /* ignore */
      }
      throw new HttpError(500, 'workspace-corrupt', `workspace.json 写后校验失败（${validation.reason}），已尝试恢复备份`)
    }
  }

  function removeRefsFallback(ids) {
    const doc = readWorkspaceDocRaw()
    if (!doc) return { changed: false, reason: 'missing' }
    assertWorkspaceWritable(doc)
    const statBefore = fs.statSync(WORKSPACE_JSON)
    const set = new Set(ids)
    let changed = false
    for (const record of Object.values(doc.tables.workspaces)) {
      if (!record || typeof record !== 'object' || !Array.isArray(record.sessionIds)) continue
      const next = record.sessionIds.filter((id) => !set.has(String(id)))
      if (next.length !== record.sessionIds.length) {
        record.sessionIds = next
        record.updatedAt = nowIso()
        changed = true
      }
    }
    const global = doc.global
    for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
      if (!Array.isArray(global[key])) continue
      const next = global[key].filter((id) => !set.has(String(id)))
      if (next.length !== global[key].length) {
        global[key] = next
        changed = true
      }
    }
    if (!changed) return { changed: false }
    writeWorkspaceDocAtomic(doc, statBefore)
    return { changed: true, strategy: 'file' }
  }

  function addRefsFallback(sessionId, meta) {
    const doc = readWorkspaceDocRaw()
    if (!doc) throw new HttpError(409, 'workspace-readonly', 'workspace.json 不存在，无法恢复引用')
    assertWorkspaceWritable(doc)
    const statBefore = fs.statSync(WORKSPACE_JSON)
    const target =
      Object.entries(doc.tables.workspaces).find(([id]) => id === meta.workspaceId)?.[1] ??
      Object.values(doc.tables.workspaces).find(
        (record) => record && typeof record.path === 'string' && compareKey(record.path) === compareKey(meta.workspacePath || ''),
      )
    let changed = false
    if (target && typeof target === 'object') {
      if (!Array.isArray(target.sessionIds)) target.sessionIds = []
      if (!target.sessionIds.includes(sessionId)) {
        target.sessionIds.unshift(sessionId)
        target.updatedAt = nowIso()
        changed = true
      }
    }
    const global = doc.global
    if (meta.wasArchived === true) {
      if (!Array.isArray(global.archivedSessionIds)) global.archivedSessionIds = []
      if (!global.archivedSessionIds.includes(sessionId)) {
        global.archivedSessionIds.push(sessionId)
        changed = true
      }
      if (Array.isArray(global.pinnedSessionIds)) {
        const next = global.pinnedSessionIds.filter((id) => id !== sessionId)
        if (next.length !== global.pinnedSessionIds.length) {
          global.pinnedSessionIds = next
          changed = true
        }
      }
    } else if (meta.wasPinned === true) {
      if (!Array.isArray(global.pinnedSessionIds)) global.pinnedSessionIds = []
      if (!global.pinnedSessionIds.includes(sessionId)) {
        global.pinnedSessionIds.unshift(sessionId)
        changed = true
      }
    }
    if (changed) writeWorkspaceDocAtomic(doc, statBefore)
    return { changed }
  }

  async function detachRefs(id, captured) {
    const registry = captured?.snapshot?.registry ?? getWorkspaceRegistry()
    if (registry && typeof registry.list === 'function') {
      let changed = false
      const workspaces = registry.list()
      const ownerIds = new Set()
      if (captured?.workspaceId) ownerIds.add(String(captured.workspaceId))
      for (const workspace of workspaces) {
        if (!workspace || typeof workspace.id !== 'string') continue
        const rawListed = captured?.snapshot?.raw?.workspaces?.some(
          (entry) => entry.id === workspace.id && entry.sessionIds.includes(id),
        )
        const getterListed = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)
        if (rawListed || getterListed) ownerIds.add(workspace.id)
      }
      for (const workspace of workspaces) {
        if (!workspace || !ownerIds.has(workspace.id) || typeof workspace.detachSession !== 'function') continue
        try {
          await workspace.detachSession(id)
          changed = true
        } catch (error) {
          throw new HttpError(500, 'refs-failed', `卸载工作区引用失败：${safeString(error?.message ?? error)}`)
        }
      }
      if (captured?.wasArchived && typeof registry.unarchiveSession === 'function') {
        await registry.unarchiveSession(id)
        changed = true
      }
      if (captured?.wasPinned && typeof registry.unpinSession === 'function') {
        await registry.unpinSession(id)
        changed = true
      }
      return { changed, strategy: 'registry' }
    }
    return removeRefsFallback([id])
  }

  async function attachRefs(id, meta) {
    const warnings = []
    const registry = getWorkspaceRegistry()
    if (registry && typeof registry.list === 'function') {
      let workspace = null
      try {
        const list = registry.list()
        workspace =
          list.find((item) => String(item.id ?? '') === String(meta.workspaceId ?? '')) ??
          list.find(
            (item) =>
              typeof item.path === 'string' &&
              meta.workspacePath &&
              compareKey(item.path) === compareKey(meta.workspacePath),
          ) ??
          null
      } catch (error) {
        warnings.push(`读取工作区失败：${safeString(error?.message ?? error, 500)}`)
      }
      if (meta.wasListed !== false && workspace && typeof workspace.attachSession === 'function') {
        try {
          await workspace.attachSession(id)
        } catch (error) {
          warnings.push(`恢复工作区引用失败：${safeString(error?.message ?? error, 500)}`)
        }
      }
      if (meta.wasArchived === true && typeof registry.archiveSession === 'function') {
        try {
          await registry.archiveSession(id)
        } catch (error) {
          warnings.push(`恢复归档状态失败：${safeString(error?.message ?? error, 500)}`)
        }
      } else if (meta.wasPinned === true && typeof registry.pinSession === 'function') {
        try {
          await registry.pinSession(id)
        } catch (error) {
          warnings.push(`恢复置顶状态失败：${safeString(error?.message ?? error, 500)}`)
        }
      }
      return { changed: warnings.length === 0, strategy: 'registry', warnings }
    }
    try {
      const result = addRefsFallback(id, meta)
      return { ...result, strategy: 'file', warnings }
    } catch (error) {
      warnings.push(`恢复 workspace.json 引用失败：${safeString(error?.message ?? error, 500)}`)
      return { changed: false, strategy: 'file', warnings }
    }
  }

  // ── 会话目录扫描 ───────────────────────────────────────────────
  function scanSessionDirs() {
    const { root } = resolveSessionsRootInfo()
    const dirs = new Map()
    const ambiguous = new Set()
    if (!root || !isRealDirectory(root)) return { root, dirs, ambiguous }
    let slugs = []
    try {
      slugs = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return { root, dirs, ambiguous }
    }
    for (const slugEntry of slugs) {
      if (!slugEntry.isDirectory() || slugEntry.isSymbolicLink()) continue
      let slug
      try {
        slug = assertSingleSegment(slugEntry.name, 'workspace slug')
      } catch {
        continue
      }
      const slugDir = path.join(root, slug)
      if (!isRealDirectory(slugDir)) continue
      let sessionEntries = []
      try {
        sessionEntries = fs.readdirSync(slugDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of sessionEntries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        let id
        try {
          id = assertSingleSegment(entry.name, 'session id')
        } catch {
          continue
        }
        if (!ANY_SESSION_ID_RE.test(id)) continue
        const dir = path.join(slugDir, id)
        if (!isRealDirectory(dir) || !looksLikeSessionDir(dir)) continue
        if (dirs.has(id)) {
          ambiguous.add(id)
          continue
        }
        dirs.set(id, { dir, slug, dirName: id })
      }
    }
    return { root, dirs, ambiguous }
  }

  function findSessionDir(id) {
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) throw new HttpError(400, 'bad-id', '会话 id 不合法')
    const scan = scanSessionDirs()
    if (scan.ambiguous.has(id)) throw new HttpError(409, 'ambiguous', POLICY_MESSAGES.ambiguous)
    const found = scan.dirs.get(id)
    if (!found) throw new HttpError(404, 'not-found', '这条会话在磁盘上不存在（可能已被删除）')
    return found
  }

  function projectTitle(id) {
    const rec = readJsonSafe(path.join(PROJ_CACHE_DIR, `${id}.json`))
    const row = rec?.record?.rows?.title
    const title = row && typeof row.val === 'string' ? row.val : ''
    const cwd = rec?.record?.identity?.cwd
    return { title: safeString(title, 300), cwd: typeof cwd === 'string' ? cwd : '' }
  }

  async function readStoredHeaders() {
    const map = new Map()
    const sizes = new Map()
    const warnings = []
    const persistence = getPersistence()
    if (!persistence || typeof persistence.list !== 'function') {
      return { map, sizes, warnings, source: 'none' }
    }
    try {
      const snapshots = await persistence.list()
      if (Array.isArray(snapshots)) {
        for (const snapshot of snapshots) {
          const header = snapshot?.header
          if (!header || typeof header.id !== 'string') continue
          map.set(header.id, header)
          if (Number.isFinite(snapshot.sizeBytes)) sizes.set(header.id, Number(snapshot.sizeBytes))
        }
      }
    } catch (error) {
      warnings.push(`sessionPersistence.list() 失败，标题/归属降级：${safeString(error?.message ?? error, 500)}`)
    }
    const sessions = sessionsService()
    if (sessions && typeof sessions.list === 'function') {
      try {
        const list = sessions.list()
        if (Array.isArray(list)) {
          for (const item of list) {
            const header = item?.header
            if (header && typeof header.id === 'string' && !map.has(header.id)) map.set(header.id, header)
          }
        }
      } catch {
        /* ignore */
      }
    }
    return { map, sizes, warnings, source: 'sessionPersistence' }
  }

  async function listSessions() {
    const snapshot = workspaceSnapshot()
    const scan = scanSessionDirs()
    const stored = await readStoredHeaders()
    const live = liveIdSet()
    const warnings = [...snapshot.warnings, ...stored.warnings]
    const sessions = []
    for (const [id, found] of scan.dirs) {
      const header = stored.map.get(id) ?? null
      const meta = projectTitle(id)
      const cwd = typeof header?.cwd === 'string' && header.cwd ? header.cwd : meta.cwd
      const owner = findWorkspaceForSession(id, snapshot) ?? findWorkspaceForCwd(cwd, snapshot)
      const state = liveness(id)
      const kind = header?.origin === 'subagent' || header?.parentSession ? 'subagent' : sessionKind(id)
      const archived = snapshot.archived.has(id)
      const pinned = snapshot.pinned.has(id)
      const blockedReason =
        scan.ambiguous.has(id)
          ? 'ambiguous'
          : state !== 'free'
            ? state
            : policyBlockForId(id, { pinned, archived })
      const sizes = sessionDirBytes(found.dir)
      const childCount = [...stored.map.values()].filter((item) => item?.parentSession === id).length
      sessions.push({
        id,
        dirName: found.dirName,
        kind,
        blockedReason,
        deletable: blockedReason === null,
        bytes: stored.sizes.get(id) ?? sizes.bytes,
        updatedAt: sizes.updatedAt ?? sessionDirMtime(found.dir),
        title: meta.title,
        workspacePath: owner?.path || cwd || '',
        workspaceTitle: owner?.title ?? '',
        workspaceId: owner?.id ?? '',
        listed: Boolean(owner && owner.sessionIds.includes(id)),
        archived,
        pinned,
        liveness: state,
        live: state !== 'free',
        childSessionCount: childCount,
        unverified: !header,
        inTrash: false,
      })
    }
    sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    return { snapshot, scan, sessions, warnings, stored }
  }

  // ── 回收站 ────────────────────────────────────────────────────
  function normalizeMeta(entryId, raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, reason: 'orphan', meta: null }
    }
    if (raw.entryId !== undefined && raw.entryId !== entryId) return { valid: false, reason: 'entry-mismatch', meta: null }
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
    if (!ANY_SESSION_ID_RE.test(sessionId)) return { valid: false, reason: 'bad-session', meta: null }
    if (!entryId.endsWith(`_${sessionId}`)) return { valid: false, reason: 'entry-mismatch', meta: null }
    let workspaceSlug
    try {
      workspaceSlug = assertSingleSegment(String(raw.workspaceSlug ?? ''), 'workspaceSlug')
    } catch {
      return { valid: false, reason: 'bad-slug', meta: null }
    }
    let sessionDirName
    try {
      sessionDirName = assertSingleSegment(String(raw.sessionDirName ?? sessionId), 'sessionDirName')
    } catch {
      return { valid: false, reason: 'bad-dirname', meta: null }
    }
    if (ANY_SESSION_ID_RE.test(sessionId) && sessionDirName !== sessionId) {
      return { valid: false, reason: 'dir-mismatch', meta: null }
    }
    const deletedAt = typeof raw.deletedAt === 'string' ? raw.deletedAt : ''
    const deletedMs = Date.parse(deletedAt)
    if (!Number.isFinite(deletedMs)) return { valid: false, reason: 'bad-date', meta: null }
    const projectionFiles = Array.isArray(raw.projectionFiles)
      ? raw.projectionFiles.filter((name) => typeof name === 'string' && !name.includes('/') && !name.includes('\\')).slice(0, 32)
      : []
    const meta = {
      metaVersion: 2,
      entryId,
      sessionId,
      sessionDirName,
      workspaceSlug,
      workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
      workspacePath: typeof raw.workspacePath === 'string' ? raw.workspacePath : '',
      sessionsRoot: typeof raw.sessionsRoot === 'string' ? raw.sessionsRoot : '',
      title: safeString(typeof raw.title === 'string' ? raw.title : '', 300),
      originalPath: typeof raw.originalPath === 'string' ? raw.originalPath : '',
      projectionFiles,
      deletedAt,
      deletedMs,
      bytes: Number.isFinite(Number(raw.bytes)) ? Number(raw.bytes) : 0,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      complete: raw.complete !== false,
      wasListed: raw.wasListed === true || (raw.wasListed === undefined && Boolean(raw.workspaceId)),
      wasArchived: raw.wasArchived === true,
      wasPinned: raw.wasPinned === true,
      refsPending: raw.refsPending === true,
      broken: raw.broken === true,
    }
    return { valid: true, reason: null, meta }
  }

  function readTrashEntry(entryId) {
    if (typeof entryId !== 'string' || !TRASH_ENTRY_ID_RE.test(entryId)) {
      throw new HttpError(400, 'bad-entry', '回收站条目 id 不合法')
    }
    const dir = path.join(TRASH_DIR, entryId)
    const stat = lstatOrNull(dir)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new HttpError(404, 'not-found', '回收站里没有这个条目')
    }
    const raw = readJsonSafe(path.join(dir, 'meta.json'))
    return { entryId, dir, ...normalizeMeta(entryId, raw) }
  }

  function scanTrashEntries() {
    const entries = []
    try {
      fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 })
    } catch {
      return entries
    }
    let dirents = []
    try {
      dirents = fs.readdirSync(TRASH_DIR, { withFileTypes: true })
    } catch {
      return entries
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
      if (!TRASH_ENTRY_ID_RE.test(dirent.name)) continue
      try {
        entries.push(readTrashEntry(dirent.name))
      } catch {
        /* 单个损坏目录不影响其它条目 */
      }
    }
    return entries
  }

  function validTrashEntries() {
    return scanTrashEntries().filter((entry) => entry.valid)
  }

  function payloadOf(entry) {
    return path.join(entry.dir, 'payload')
  }

  function removeTrashEntry(entry) {
    if (!entry || !entry.valid) throw new HttpError(403, 'orphan', POLICY_MESSAGES.orphan)
    const target = path.resolve(entry.dir)
    if (!isPathInside(target, path.resolve(TRASH_DIR))) throw new HttpError(403, 'bad-entry', '条目路径越界')
    assertNoSymlinkAncestors(target, TRASH_DIR)
    fs.rmSync(target, { recursive: true, force: true })
  }

  function moveProjectionFiles(id, entryDir) {
    const projectionDir = path.join(entryDir, 'projection')
    const names = []
    if (!isRealDirectory(PROJ_CACHE_DIR)) return names
    try {
      for (const name of fs.readdirSync(PROJ_CACHE_DIR)) {
        if (name !== `${id}.json` && !name.startsWith(`${id}.json.bak`)) continue
        const from = path.join(PROJ_CACHE_DIR, name)
        const stat = lstatOrNull(from)
        if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue
        if (!names.length) fs.mkdirSync(projectionDir, { recursive: true, mode: 0o700 })
        fs.renameSync(from, path.join(projectionDir, name))
        names.push(name)
      }
    } catch (error) {
      throw new HttpError(500, 'projection-failed', `移动投影缓存失败：${safeString(error?.message ?? error)}`)
    }
    return names
  }

  function restoreProjectionFiles(meta, entryDir) {
    const warnings = []
    const projectionDir = path.join(entryDir, 'projection')
    try {
      fs.mkdirSync(PROJ_CACHE_DIR, { recursive: true, mode: 0o700 })
    } catch (error) {
      warnings.push(`创建投影缓存目录失败：${safeString(error?.message ?? error, 500)}`)
      return warnings
    }
    for (const name of meta.projectionFiles) {
      if (typeof name !== 'string' || !name.startsWith(`${meta.sessionId}.json`)) continue
      if (name.includes('/') || name.includes('\\') || name.includes('..')) continue
      const from = path.join(projectionDir, name)
      const to = path.join(PROJ_CACHE_DIR, name)
      const stat = lstatOrNull(from)
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue
      if (lstatOrNull(to)) {
        warnings.push(`投影缓存目标已存在，跳过：${name}`)
        continue
      }
      try {
        assertNoSymlinkAncestors(PROJ_CACHE_DIR, HOME)
        fs.renameSync(from, to)
      } catch (error) {
        warnings.push(`恢复投影缓存失败：${name}：${safeString(error?.message ?? error, 300)}`)
      }
    }
    return warnings
  }

  // ── 移动/还原/清理 ─────────────────────────────────────────────
  async function moveToTrash(id, { reason = 'manual' } = {}) {
    const found = findSessionDir(id)
    const scan = scanSessionDirs()
    if (scan.ambiguous.has(id)) throw new HttpError(409, 'ambiguous', POLICY_MESSAGES.ambiguous)
    const meta0 = projectTitle(id)
    const captured = captureRefs(id, meta0.cwd)
    assertPolicy(id, { meta: { pinned: captured.wasPinned, archived: captured.wasArchived } })
    assertDeletable(id)
    await assertNoActivity(id)

    const sizes = sessionDirBytes(found.dir)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17)
    let entryId = `${stamp}_${id}`
    let suffix = 1
    while (lstatOrNull(path.join(TRASH_DIR, entryId))) entryId = `${stamp}_${suffix++}_${id}`
    const entryDir = path.join(TRASH_DIR, entryId)
    fs.mkdirSync(entryDir, { recursive: true, mode: 0o700 })
    assertNoSymlinkAncestors(entryDir, TRASH_DIR)

    const sessionsRootInfo = resolveSessionsRootInfo()
    const metaDoc = {
      metaVersion: 2,
      entryId,
      sessionId: id,
      sessionDirName: found.dirName,
      workspaceSlug: found.slug,
      workspaceId: captured.workspaceId,
      workspacePath: captured.workspacePath,
      sessionsRoot: sessionsRootInfo.root,
      title: meta0.title,
      originalPath: found.dir,
      projectionFiles: [],
      deletedAt: nowIso(),
      bytes: sizes.bytes,
      reason,
      complete: false,
      wasListed: captured.wasListed,
      wasArchived: captured.wasArchived,
      wasPinned: captured.wasPinned,
      refsPending: false,
      pluginVersion: '2.0.0',
    }
    const metaPath = path.join(entryDir, 'meta.json')
    writeJsonAtomic(metaPath, metaDoc)

    let projections = []
    try {
      fs.renameSync(found.dir, path.join(entryDir, 'payload'))
      projections = moveProjectionFiles(id, entryDir)
      metaDoc.projectionFiles = projections
      writeJsonAtomic(metaPath, { ...metaDoc, complete: true })
    } catch (error) {
      let rolledBack = true
      try {
        if (!lstatOrNull(found.dir) && isRealDirectory(path.join(entryDir, 'payload'))) {
          fs.renameSync(path.join(entryDir, 'payload'), found.dir)
        }
        const projectionDir = path.join(entryDir, 'projection')
        for (const name of projections) {
          const from = path.join(projectionDir, name)
          if (!lstatOrNull(path.join(PROJ_CACHE_DIR, name)) && lstatOrNull(from)) {
            fs.renameSync(from, path.join(PROJ_CACHE_DIR, name))
          }
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
      log({ action: 'trash-failed', sessionId: id, entryId, rolledBack, error: String(error?.message ?? error) })
      throw new HttpError(500, 'move-failed', `移入回收站失败：${safeString(error?.message ?? error)}`)
    }

    let refsResult
    try {
      refsResult = await detachRefs(id, captured)
    } catch (error) {
      refsResult = { changed: false, strategy: captured.snapshot.source, warnings: [safeString(error?.message ?? error, 500)] }
      writeJsonAtomic(metaPath, { ...metaDoc, complete: true, projectionFiles: projections, refsPending: true })
    }
    const pending = readPending().filter((item) => item.sessionId !== id)
    writePending(pending)
    log({
      action: 'trash',
      sessionId: id,
      entryId,
      bytes: sizes.bytes,
      refs: refsResult.changed === true,
      refsStrategy: refsResult.strategy,
      warnings: refsResult.warnings ?? [],
      reason,
    })
    return { entryId, bytes: sizes.bytes, refs: refsResult.changed === true, warnings: refsResult.warnings ?? [] }
  }

  function resolveRestoreTarget(meta, rootInfo) {
    const slug = assertSingleSegment(String(meta.workspaceSlug), 'workspaceSlug')
    const dirName = assertSingleSegment(String(meta.sessionDirName), 'sessionDirName')
    if (ANY_SESSION_ID_RE.test(meta.sessionId) && dirName !== meta.sessionId) {
      throw new HttpError(409, 'bad-meta', 'meta.json 的 sessionDirName 与 sessionId 不一致')
    }
    if (meta.originalPath) {
      const base = path.basename(meta.originalPath)
      const parent = path.basename(path.dirname(meta.originalPath))
      if (base !== dirName || parent !== slug) throw new HttpError(409, 'bad-meta', 'meta.json 的 originalPath 与目录信息不一致')
    }
    const root = path.resolve(rootInfo.root)
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new HttpError(500, 'restore-root', `创建会话根失败：${safeString(error?.message ?? error)}`)
    }
    const canonicalRoot = realpathNative(root)
    const parent = resolveUnderRoot(canonicalRoot, slug)
    try {
      fs.mkdirSync(parent, { recursive: false, mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new HttpError(500, 'restore-parent', `创建会话父目录失败：${safeString(error?.message ?? error)}`)
    }
    const canonicalParent = realpathNative(parent)
    if (!isSamePath(canonicalParent, canonicalRoot) && !isPathInside(canonicalParent, canonicalRoot)) {
      throw new HttpError(409, 'bad-meta', '还原目标的父目录不在会话根内')
    }
    assertNoSymlinkAncestors(parent, canonicalRoot)
    const target = resolveUnderRoot(canonicalParent, dirName)
    if (!isPathInside(target, canonicalRoot)) throw new HttpError(409, 'bad-meta', '还原目标不在会话根内')
    if (lstatOrNull(target)) throw new HttpError(409, 'occupied', '原位置已经有同名会话目录，未做还原')
    return target
  }

  async function restore(entryId) {
    const entry = readTrashEntry(entryId)
    if (!entry.valid) throw new HttpError(409, 'bad-meta', `回收站条目元数据不一致（${entry.reason}）`)
    if (entry.meta.complete === false) throw new HttpError(409, 'incomplete', POLICY_MESSAGES.incomplete)
    if (entry.meta.broken === true) throw new HttpError(409, 'broken', POLICY_MESSAGES.broken)
    const payload = payloadOf(entry)
    if (!isRealDirectory(payload)) throw new HttpError(500, 'broken', '回收站条目缺少正文，无法还原')
    const rootInfo = resolveSessionsRootInfo()
    const target = resolveRestoreTarget(entry.meta, rootInfo)
    fs.renameSync(payload, target)
    const warnings = restoreProjectionFiles(entry.meta, entry.dir)
    const refs = await attachRefs(entry.meta.sessionId, entry.meta)
    warnings.push(...(refs.warnings ?? []))
    if (refs.warnings?.length) {
      appendRepair({
        kind: 'attach',
        sessionId: entry.meta.sessionId,
        workspaceId: entry.meta.workspaceId,
        workspacePath: entry.meta.workspacePath,
        wasListed: entry.meta.wasListed,
        wasArchived: entry.meta.wasArchived,
        wasPinned: entry.meta.wasPinned,
        requestedAt: nowIso(),
      })
    }
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true })
    } catch (error) {
      warnings.push(`回收站条目清理失败：${safeString(error?.message ?? error, 300)}`)
    }
    log({ action: 'restore', sessionId: entry.meta.sessionId, entryId, refs: refs.changed === true, warnings })
    return { sessionId: entry.meta.sessionId, refs: refs.changed === true, warnings }
  }

  function purge(entryId, typedConfirm) {
    const entry = readTrashEntry(entryId)
    if (!entry.valid) throw new HttpError(403, 'orphan', POLICY_MESSAGES.orphan)
    assertPolicy(entry.meta.sessionId, { forPurge: true, meta: entry.meta })
    const code = trashPolicyRejection(entry.meta)
    if (code) throwPolicy(code)
    assertTypedConfirm(typedConfirm, 1, '彻底删除')
    removeTrashEntry(entry)
    log({ action: 'purge', entryId, sessionId: entry.meta.sessionId })
    return { entryId }
  }

  function purgeAll(confirmCount, typedConfirm) {
    assertEnabled()
    if (!POLICY.allowPurge) throwPolicy('purge-disabled')
    const listed = validTrashEntries()
    let names = []
    try {
      names = fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name)
    } catch {
      names = []
    }
    if (listed.length === 0 && names.length === 0) throw new HttpError(409, 'empty-trash', '回收站已经是空的')
    if (Number(confirmCount) !== listed.length) {
      throw new HttpError(409, 'stale', `回收站内容已变化（界面显示 ${confirmCount} 条，实际 ${listed.length} 条），请刷新后重试`)
    }
    if (String(typedConfirm ?? '') !== POLICY.purgeConfirmWord) {
      throw new HttpError(400, 'confirm-word', `清空回收站：需要输入确认词 ${POLICY.purgeConfirmWord}`)
    }
    const byName = new Map(listed.map((entry) => [entry.entryId, entry]))
    const skipped = []
    let count = 0
    for (const name of names) {
      if (!TRASH_ENTRY_ID_RE.test(name)) continue
      const entry = byName.get(name)
      if (!entry) {
        skipped.push({ entryId: name, code: 'orphan' })
        continue
      }
      const code = trashPolicyRejection(entry.meta)
      if (code) {
        skipped.push({ entryId: name, sessionId: entry.meta.sessionId, code })
        continue
      }
      try {
        removeTrashEntry(entry)
        count += 1
      } catch (error) {
        skipped.push({ entryId: name, sessionId: entry.meta.sessionId, code: 'error', error: safeString(error?.message ?? error, 500) })
      }
    }
    log({ action: 'purge-all', count, skipped: skipped.length, skippedCodes: skipped.map((item) => item.code) })
    return { count, skipped }
  }

  // ── 删除/还原批量 ──────────────────────────────────────────────
  async function batchTrash(ids, confirmCount) {
    assertEnabled()
    const list = assertBatch(ids, confirmCount, '批量删除')
    const results = []
    for (const id of list) {
      try {
        const result = await moveToTrash(id, { reason: 'batch' })
        results.push({ id, ok: true, entryId: result.entryId, bytes: result.bytes, warnings: result.warnings })
      } catch (error) {
        results.push({
          id,
          ok: false,
          code: error instanceof HttpError ? error.code : 'error',
          error: safeString(error?.message ?? error),
        })
      }
    }
    const succeeded = results.filter((result) => result.ok).length
    log({ action: 'trash-batch', requested: list.length, succeeded, failed: list.length - succeeded })
    return { results, succeeded, failed: list.length - succeeded }
  }

  async function batchRestore(entryIds) {
    const list = assertBatch(entryIds, undefined, '批量还原')
    const results = []
    for (const entryId of list) {
      try {
        const result = await restore(entryId)
        results.push({ entryId, ok: true, sessionId: result.sessionId, warnings: result.warnings })
      } catch (error) {
        results.push({
          entryId,
          ok: false,
          code: error instanceof HttpError ? error.code : 'error',
          error: safeString(error?.message ?? error),
        })
      }
    }
    const succeeded = results.filter((result) => result.ok).length
    log({ action: 'restore-batch', requested: list.length, succeeded, failed: list.length - succeeded })
    return { results, succeeded, failed: list.length - succeeded }
  }

  async function batchPurge(entryIds, confirmCount, typedConfirm) {
    assertEnabled()
    if (!POLICY.allowPurge) throwPolicy('purge-disabled')
    const list = assertBatch(entryIds, confirmCount, '批量彻底删除')
    assertTypedConfirm(typedConfirm, list.length, '批量彻底删除')
    const results = []
    for (const entryId of list) {
      try {
        purge(entryId, typedConfirm)
        results.push({ entryId, ok: true })
      } catch (error) {
        results.push({
          entryId,
          ok: false,
          code: error instanceof HttpError ? error.code : 'error',
          error: safeString(error?.message ?? error),
        })
      }
    }
    const succeeded = results.filter((result) => result.ok).length
    log({ action: 'purge-batch', requested: list.length, succeeded, failed: list.length - succeeded })
    return { results, succeeded, failed: list.length - succeeded }
  }

  // ── 排队 ──────────────────────────────────────────────────────
  function readPending() {
    const doc = readJsonSafe(PENDING_FILE)
    if (!Array.isArray(doc)) return []
    const seen = new Set()
    const out = []
    for (const item of doc) {
      if (!item || typeof item !== 'object') continue
      const sessionId = typeof item.sessionId === 'string' ? item.sessionId : ''
      if (!ANY_SESSION_ID_RE.test(sessionId) || seen.has(sessionId)) continue
      seen.add(sessionId)
      out.push({
        sessionId,
        requestedAt: typeof item.requestedAt === 'string' ? item.requestedAt : nowIso(),
        title: safeString(typeof item.title === 'string' ? item.title : '', 300),
        workspacePath: typeof item.workspacePath === 'string' ? item.workspacePath : '',
        cwd: typeof item.cwd === 'string' ? item.cwd : '',
        createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : null,
        reason: typeof item.reason === 'string' ? item.reason : 'queued-while-live',
      })
      if (out.length >= POLICY.maxPending) break
    }
    return out
  }
  function writePending(list) {
    writeJsonAtomic(PENDING_FILE, list.slice(0, POLICY.maxPending))
  }
  function readRepairs() {
    const doc = readJsonSafe(REPAIR_FILE)
    return Array.isArray(doc) ? doc.filter((item) => item && typeof item.sessionId === 'string') : []
  }
  function writeRepairs(list) {
    writeJsonAtomic(REPAIR_FILE, list.slice(0, POLICY.maxPending))
  }
  function appendRepair(item) {
    const list = readRepairs()
    if (!list.some((entry) => entry.kind === item.kind && entry.sessionId === item.sessionId)) list.push(item)
    writeRepairs(list)
  }

  function assertQueueable(id) {
    assertEnabled()
    const snapshot = workspaceSnapshot()
    const code = policyBlockForId(id, {
      pinned: snapshot.pinned.has(id),
      archived: snapshot.archived.has(id),
    })
    if (code) throwPolicy(code)
  }

  async function queue(id) {
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) throw new HttpError(400, 'bad-id', '会话 id 不合法')
    findSessionDir(id)
    assertQueueable(id)
    const list = readPending()
    if (list.some((item) => item.sessionId === id)) return { sessionId: id }
    if (list.length >= POLICY.maxPending) throw new HttpError(413, 'pending-full', `排队表已达上限 ${POLICY.maxPending} 条`)
    const meta = projectTitle(id)
    const stored = await readStoredHeaders()
    const header = stored.map.get(id) ?? null
    const found = findSessionDir(id)
    list.push({
      sessionId: id,
      requestedAt: nowIso(),
      title: meta.title,
      workspacePath: typeof header?.cwd === 'string' && header.cwd ? header.cwd : meta.cwd,
      cwd: typeof header?.cwd === 'string' ? header.cwd : meta.cwd,
      createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
      reason: 'queued-while-live',
    })
    writePending(list)
    log({ action: 'queue', sessionId: id })
    return { sessionId: id }
  }
  function unqueue(id) {
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) throw new HttpError(400, 'bad-id', '会话 id 不合法')
    const list = readPending().filter((item) => item.sessionId !== id)
    writePending(list)
    log({ action: 'unqueue', sessionId: id })
    return { sessionId: id }
  }

  function permanentPendingCode(code) {
    return [
      'disabled',
      'purge-disabled',
      'protected',
      'subagent-protected',
      'pinned-protected',
      'archived-protected',
      'bad-id',
      'ambiguous',
      'identity-changed',
    ].includes(code)
  }

  async function processPending({ trigger = 'manual' } = {}) {
    assertEnabled()
    const list = readPending()
    if (!list.length) {
      startupReport = []
      return { results: [], succeeded: 0, failed: 0, remaining: 0, trigger }
    }
    const stored = await readStoredHeaders()
    const results = []
    const keep = []
    for (const item of list) {
      const id = item.sessionId
      try {
        const found = findSessionDir(id)
        const header = stored.map.get(id) ?? null
        if (item.createdAt !== null && header && Number.isFinite(header.createdAt) && header.createdAt !== item.createdAt) {
          results.push({ sessionId: id, result: 'dropped', code: 'identity-changed' })
          continue
        }
        if (item.cwd && typeof header?.cwd === 'string' && header.cwd && compareKey(item.cwd) !== compareKey(header.cwd)) {
          results.push({ sessionId: id, result: 'dropped', code: 'identity-changed' })
          continue
        }
        if (!found) {
          results.push({ sessionId: id, result: 'already-gone' })
          continue
        }
        const result = await moveToTrash(id, { reason: trigger === 'startup' ? 'pending-at-startup' : 'pending-manual' })
        results.push({ sessionId: id, result: 'trashed', entryId: result.entryId, warnings: result.warnings })
      } catch (error) {
        const code = error instanceof HttpError ? error.code : 'error'
        if (permanentPendingCode(code)) {
          results.push({ sessionId: id, result: 'dropped', code, error: safeString(error?.message ?? error) })
        } else if (code === 'not-found') {
          results.push({ sessionId: id, result: 'already-gone' })
        } else {
          keep.push(item)
          results.push({ sessionId: id, result: code === 'live' ? 'still-live' : code === 'activity-unknown' ? 'activity-unknown' : 'failed', code, error: safeString(error?.message ?? error) })
        }
      }
    }
    writePending(keep)
    startupReport = results
    log({ action: 'process-pending', trigger, results })
    return {
      results,
      succeeded: results.filter((item) => item.result === 'trashed').length,
      failed: results.filter((item) => item.result === 'failed' || item.result === 'dropped').length,
      remaining: keep.length,
      trigger,
    }
  }

  async function retryPendingRefs() {
    const registry = getWorkspaceRegistry()
    if (!registry) return { retried: 0, cleared: 0 }
    let retried = 0
    let cleared = 0
    for (const entry of validTrashEntries()) {
      if (!entry.meta.refsPending) continue
      retried += 1
      try {
        await detachRefs(entry.meta.sessionId, {
          wasListed: entry.meta.wasListed,
          workspaceId: entry.meta.workspaceId,
          wasArchived: entry.meta.wasArchived,
          wasPinned: entry.meta.wasPinned,
          snapshot: { registry, raw: readIndex() },
        })
        writeJsonAtomic(path.join(entry.dir, 'meta.json'), { ...entry.meta, refsPending: false })
        cleared += 1
      } catch {
        /* 下次再试 */
      }
    }
    if (retried) log({ action: 'retry-refs', retried, cleared })
    return { retried, cleared }
  }

  async function retryRepairs() {
    const list = readRepairs()
    if (!list.length) return { retried: 0, cleared: 0 }
    const registry = getWorkspaceRegistry()
    if (!registry) return { retried: 0, cleared: 0 }
    const keep = []
    let cleared = 0
    for (const item of list) {
      if (item.kind !== 'attach') {
        keep.push(item)
        continue
      }
      try {
        const meta = {
          sessionId: item.sessionId,
          workspaceId: item.workspaceId,
          workspacePath: item.workspacePath,
          wasListed: item.wasListed !== false,
          wasArchived: item.wasArchived === true,
          wasPinned: item.wasPinned === true,
        }
        const result = await attachRefs(item.sessionId, meta)
        if (result.warnings?.length) keep.push(item)
        else cleared += 1
      } catch {
        keep.push(item)
      }
    }
    writeRepairs(keep)
    if (cleared) log({ action: 'retry-repairs', retried: list.length, cleared })
    return { retried: list.length, cleared }
  }

  // ── 回收站启动恢复 ─────────────────────────────────────────────
  function recoverTrash() {
    for (const entry of scanTrashEntries()) {
      if (!entry.valid) continue
      const payload = payloadOf(entry)
      const payloadExists = isRealDirectory(payload)
      if (entry.meta.complete === false) {
        if (payloadExists) {
          writeJsonAtomic(path.join(entry.dir, 'meta.json'), { ...entry.meta, complete: true })
          log({ action: 'trash-recovered', entryId: entry.entryId, sessionId: entry.meta.sessionId })
        } else {
          let names = []
          try {
            names = fs.readdirSync(entry.dir)
          } catch {
            names = []
          }
          const onlyEmpty = names.every((name) => name === 'meta.json' || name === 'projection')
          if (onlyEmpty) {
            try {
              fs.rmSync(entry.dir, { recursive: true, force: true })
              log({ action: 'trash-empty-removed', entryId: entry.entryId })
            } catch {
              /* ignore */
            }
          } else {
            writeJsonAtomic(path.join(entry.dir, 'meta.json'), { ...entry.meta, broken: true })
            log({ action: 'trash-broken', entryId: entry.entryId })
          }
        }
      } else if (!payloadExists) {
        writeJsonAtomic(path.join(entry.dir, 'meta.json'), { ...entry.meta, broken: true })
        log({ action: 'trash-broken', entryId: entry.entryId })
      }
    }
  }

  // ── 自动清理 ──────────────────────────────────────────────────
  let lastSweep = null
  function sweepTrash() {
    if (!POLICY.enabled || !POLICY.allowPurge) {
      lastSweep = { removed: 0, skipped: 0, reason: 'policy' }
      return lastSweep
    }
    if (!Number.isFinite(keepDays) || keepDays <= 0) {
      lastSweep = { removed: 0, skipped: 0, reason: 'disabled' }
      return lastSweep
    }
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000
    let removed = 0
    const skipped = []
    for (const entry of validTrashEntries()) {
      const at = Number(entry.meta.deletedMs)
      if (!Number.isFinite(at) || at >= cutoff) continue
      const code = trashPolicyRejection(entry.meta)
      if (code) {
        skipped.push({ entryId: entry.entryId, sessionId: entry.meta.sessionId, code })
        continue
      }
      try {
        removeTrashEntry(entry)
        removed += 1
      } catch (error) {
        skipped.push({ entryId: entry.entryId, code: 'error', error: safeString(error?.message ?? error, 300) })
      }
    }
    if (removed) log({ action: 'sweep-trash', removed, skipped: skipped.length, skippedCodes: skipped.map((item) => item.code) })
    lastSweep = { removed, skipped: skipped.length, skippedCodes: skipped.map((item) => item.code) }
    return lastSweep
  }

  // ── HTTP 工具 ─────────────────────────────────────────────────
  const isLoopbackHostname = (hostname) => {
    const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
    if (!host) return false
    if (host === 'localhost' || host.endsWith('.localhost')) return true
    if (host === '::1') return true
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
    if (!match) return false
    if (Number(match[1]) !== 127) return false
    return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
  }

  const deny = (res, status) => {
    try {
      if (!res.writableEnded) {
        res.writeHead(status || 403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('forbidden')
      }
    } catch {
      /* ignore */
    }
    return true
  }

  let fenceWarned = false
  function rejected(req, res) {
    try {
      const conn = connectionFence()
      if (conn) {
        let code
        try {
          code = conn.requestRejection(req)
        } catch {
          return deny(res, 403)
        }
        if (code !== undefined && code !== null && code !== false) {
          return deny(res, typeof code === 'number' ? code : 403)
        }
        return false
      }
      const headers = req.headers ?? {}
      let hostUrl = null
      try {
        hostUrl = new URL(`http://${String(headers.host ?? '')}`)
      } catch {
        return deny(res, 403)
      }
      if (hostUrl.username || hostUrl.password || !isLoopbackHostname(hostUrl.hostname)) return deny(res, 403)
      const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
      if (site === 'cross-site') return deny(res, 403)
      const origin = headers.origin
      if (typeof origin === 'string' && origin) {
        if (origin === 'null') return deny(res, 403)
        let originUrl = null
        try {
          originUrl = new URL(origin)
        } catch {
          return deny(res, 403)
        }
        if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return deny(res, 403)
      }
      if (!fenceWarned) {
        fenceWarned = true
        log({ action: 'fence-fallback', note: '宿主 connection 栅栏不可用，使用插件自带回环/同源校验' })
      }
      return false
    } catch {
      return deny(res, 403)
    }
  }

  const sendJson = (res, status, payload) => {
    try {
      if (res.writableEnded) return
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(Buffer.byteLength(body)),
      })
      res.end(body)
    } catch {
      try {
        res.destroy?.()
      } catch {
        /* ignore */
      }
    }
  }

  const readJsonBody = (req, limit = 256 * 1024) =>
    new Promise((resolve, reject) => {
      let settled = false
      let size = 0
      const chunks = []
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      req.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > limit) {
          fail(new HttpError(413, 'too-large', '请求体过大'))
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        if (!chunks.length) return resolve({})
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return reject(new HttpError(400, 'bad-body', '请求体必须是 JSON 对象'))
          }
          resolve(body)
        } catch {
          reject(new HttpError(400, 'bad-json', '请求体不是合法 JSON'))
        }
      })
      req.on('aborted', () => fail(new HttpError(400, 'aborted', '请求已中止')))
      req.on('error', fail)
    })

  const disposers = []
  function register(pathname, handler) {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        if (rejected(req, res)) return
        try {
          await handler(req, res)
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const code = error instanceof HttpError ? error.code : 'internal'
          const isPolicy = status === 403 || status === 409 || status === 413 || code === 'confirm-word'
          if (isPolicy || !(error instanceof HttpError)) {
            log({ action: 'request-failed', path: pathname, status, code, error: safeString(error?.message ?? error) })
          }
          if (!(error instanceof HttpError)) log({ action: 'error', path: pathname, stack: String(error?.stack ?? error) })
          if (res.headersSent || res.writableEnded) {
            try {
              res.destroy?.()
            } catch {
              /* ignore */
            }
            return
          }
          sendJson(res, status, { ok: false, code, error: safeString(error?.message ?? error), details: error?.details })
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

  // ── 串行化变更 ─────────────────────────────────────────────────
  let mutationTail = Promise.resolve()
  function withMutation(task) {
    const run = mutationTail.then(task, task)
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  let startupReport = []

  // ── 路由 ──────────────────────────────────────────────────────
  register(`${ROUTE_PREFIX}/list`, async (req, res) => {
    if (!wantMethod(req, res, 'GET')) return
    const listed = await listSessions()
    const trash = validTrashEntries().map((entry) => ({
      entryId: entry.entryId,
      sessionId: entry.meta.sessionId,
      title: entry.meta.title,
      workspacePath: entry.meta.workspacePath,
      bytes: entry.meta.bytes,
      deletedAt: entry.meta.deletedAt,
      reason: entry.meta.reason,
      complete: entry.meta.complete !== false,
      broken: entry.meta.broken === true,
      refsPending: entry.meta.refsPending === true,
      wasArchived: entry.meta.wasArchived === true,
      wasPinned: entry.meta.wasPinned === true,
      purgeBlockedReason: trashPolicyRejection(entry.meta),
    }))
    const pending = readPending().map((item) => {
      const meta = projectTitle(item.sessionId)
      return {
        ...item,
        title: item.title || meta.title,
        live: liveness(item.sessionId) !== 'free',
      }
    })
    const rootInfo = resolveSessionsRootInfo()
    sendJson(res, 200, {
      ok: true,
      dshHome: HOME,
      sessionsRoot: rootInfo.root,
      sessionsRootSource: rootInfo.source,
      dataDir: DATA_DIR,
      logFile: LOG_FILE,
      policy: POLICY,
      capabilities: {
        workspaceRegistry: Boolean(getWorkspaceRegistry()),
        sessionPersistence: Boolean(getPersistence()),
        connection: Boolean(connectionFence()),
        activity: typeof ctx.waterfall === 'function' && Boolean(getWorkspaceRegistry()),
      },
      counts: {
        sessions: listed.sessions.length,
        trash: trash.length,
        pending: pending.length,
        live: listed.sessions.filter((item) => item.liveness === 'live').length,
        subagent: listed.sessions.filter((item) => item.kind === 'subagent').length,
        blocked: listed.sessions.filter((item) => !item.deletable).length,
        repairs: readRepairs().length,
        refsPending: trash.filter((item) => item.refsPending).length,
      },
      sessions: listed.sessions,
      trash,
      pending,
      startup: startupReport,
      repairs: readRepairs(),
      sweep: lastSweep,
      warnings: listed.warnings,
      log: { file: LOG_FILE, bytes: logBytes, rotated: logRotated, writeError: logWriteError },
      live: [...liveIdSet()],
    })
  })

  register(`${ROUTE_PREFIX}/delete`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(() => moveToTrash(String(body.id ?? ''), { reason: 'manual' }))
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/queue`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(() => queue(String(body.id ?? '')))
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/unqueue`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(async () => unqueue(String(body.id ?? '')))
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/restore`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(() => restore(String(body.entryId ?? '')))
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/purge`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(async () => purge(String(body.entryId ?? ''), body.typedConfirm))
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/purge-all`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(async () => purgeAll(body.confirmCount, body.typedConfirm))
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/delete-batch`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(() => batchTrash(body.ids, body.confirmCount))
    sendJson(res, 200, { ok: true, policy: POLICY, ...result })
  })

  register(`${ROUTE_PREFIX}/restore-batch`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(() => batchRestore(body.entryIds))
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/purge-batch`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(() => batchPurge(body.entryIds, body.confirmCount, body.typedConfirm))
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/process-pending`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(async () => {
      const pending = readPending()
      if (Number(body.confirmCount) !== pending.length) {
        throw new HttpError(409, 'stale', `排队表已变化（界面显示 ${body.confirmCount} 条，实际 ${pending.length} 条），请刷新后重试`)
      }
      return processPending({ trigger: 'manual' })
    })
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/repair-refs`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const result = await withMutation(async () => {
      const refs = await retryPendingRefs()
      const repairs = await retryRepairs()
      return { refs, repairs }
    })
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

  // ── 斜杠命令 ──────────────────────────────────────────────────
  const COMMAND_HELP =
    'sessions: list | trash | delete <sessionId> | delete-batch <id1,id2,…> | queue <sessionId> | unqueue <sessionId> | restore <entryId> | purge <entryId> [确认词] | purge-all [确认词]'
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
            input: { hint: 'list | delete <会话id> | restore <回收站条目id> | purge-all <确认词>' },
            handler: async ({ rawInput }) => {
              try {
                const parts = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
                const sub = parts[0] ?? 'list'
                const arg = parts[1] ?? ''
                const typed = parts[2] ?? ''
                switch (sub) {
                  case 'list': {
                    const listed = await listSessions()
                    if (!listed.sessions.length) return { kind: 'success', text: '没有会话。' }
                    return {
                      kind: 'success',
                      text: line(
                        listed.sessions.map(
                          (session) =>
                            `${session.live ? '[使用中] ' : ''}${session.kind === 'subagent' ? '[子代理] ' : ''}${session.title || '(无标题)'} — ${session.id} — ${Math.round(session.bytes / 1024)} KB`,
                        ),
                      ),
                    }
                  }
                  case 'trash': {
                    const trash = validTrashEntries()
                    if (!trash.length) return { kind: 'success', text: '回收站是空的。' }
                    return {
                      kind: 'success',
                      text: line(trash.map((entry) => `${entry.meta.title || '(无标题)'} — ${entry.meta.sessionId} — ${entry.entryId}`)),
                    }
                  }
                  case 'delete': {
                    const result = await withMutation(() => moveToTrash(arg, { reason: 'command' }))
                    return { kind: 'success', text: `已移入回收站：${arg}（条目 ${result.entryId}）` }
                  }
                  case 'delete-batch': {
                    const ids = String(arg).split(',').map((value) => value.trim()).filter(Boolean)
                    const result = await withMutation(() => batchTrash(ids, ids.length))
                    return {
                      kind: result.failed ? 'error' : 'success',
                      text:
                        `批量删除：成功 ${result.succeeded} 条，失败 ${result.failed} 条` +
                        (result.failed
                          ? '\n' + result.results.filter((row) => !row.ok).map((row) => `${row.id} — ${row.error}`).join('\n')
                          : ''),
                    }
                  }
                  case 'queue': {
                    await withMutation(() => queue(arg))
                    return { kind: 'success', text: `已排入重启后删除：${arg}` }
                  }
                  case 'unqueue': {
                    await withMutation(async () => unqueue(arg))
                    return { kind: 'success', text: `已取消排队：${arg}` }
                  }
                  case 'restore': {
                    const result = await withMutation(() => restore(arg))
                    return { kind: 'success', text: `已还原：${result.sessionId}` }
                  }
                  case 'purge': {
                    await withMutation(async () => purge(arg, typed))
                    return { kind: 'success', text: `已彻底删除：${arg}` }
                  }
                  case 'purge-all': {
                    const word = arg
                    if (word !== POLICY.purgeConfirmWord) {
                      return { kind: 'error', text: `清空回收站不可恢复：请执行 /sessions purge-all ${POLICY.purgeConfirmWord}` }
                    }
                    const result = await withMutation(async () => purgeAll(validTrashEntries().length, word))
                    return { kind: 'success', text: `回收站已清空（${result.count} 条，跳过 ${result.skipped.length} 条）` }
                  }
                  default:
                    return { kind: 'error', text: `未知子命令：${sub}\n${COMMAND_HELP}` }
                }
              } catch (error) {
                return { kind: 'error', text: String(error?.message ?? error) }
              }
            },
          })
        } catch (error) {
          log({ action: 'command-register-failed', error: String(error?.message ?? error) })
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

  // ── 启动 ──────────────────────────────────────────────────────
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 })
  } catch (error) {
    log({ action: 'data-dir-failed', error: String(error?.message ?? error) })
  }

  async function runStartup() {
    try {
      await withMutation(async () => {
        recoverTrash()
        sweepTrash()
        await retryPendingRefs()
        await retryRepairs()
        if (POLICY.processPendingOnStartup) {
          await processPending({ trigger: 'startup' })
        } else {
          startupReport = readPending().map((item) => ({ sessionId: item.sessionId, result: 'deferred' }))
        }
      })
    } catch (error) {
      log({ action: 'startup-failed', error: String(error?.message ?? error) })
    }
  }

  const startupTimer = setTimeout(runStartup, 100)
  if (typeof startupTimer.unref === 'function') startupTimer.unref()
  const retryTimer = setTimeout(() => {
    if (!POLICY.processPendingOnStartup) return
    if (readPending().length) void runStartup()
  }, 4000)
  if (typeof retryTimer.unref === 'function') retryTimer.unref()

  let sweepTimer = null
  if (POLICY.trashSweepIntervalHours > 0) {
    sweepTimer = setInterval(() => {
      void withMutation(async () => {
        recoverTrash()
        sweepTrash()
      }).catch((error) => log({ action: 'sweep-failed', error: String(error?.message ?? error) }))
    }, POLICY.trashSweepIntervalHours * 60 * 60 * 1000)
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
  }

  ctx.effect(
    () => () => {
      clearTimeout(startupTimer)
      clearTimeout(retryTimer)
      if (sweepTimer) clearInterval(sweepTimer)
    },
    'dsh-delete-guard: timers',
  )

  log({
    action: 'apply',
    dshHome: HOME,
    sessionsRoot: resolveSessionsRootInfo().root,
    sessionsRootSource,
    dataDir: DATA_DIR,
    keepDays,
    processPendingOnStartup: POLICY.processPendingOnStartup,
    logMaxBytes: POLICY.logMaxBytes,
  })
}
