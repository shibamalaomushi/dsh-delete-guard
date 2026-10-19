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

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

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
const MAX_PROJECTION_FILES = 512
const MAX_PENDING_ITEMS = 10000
const MAX_REPAIR_ITEMS = 10000
const PLUGIN_VERSION = '2.1.0'
const META_VERSION = 3
const PHASES = new Set(['prepared', 'payload-moved', 'projections-moved', 'refs-pending', 'complete', 'restoring-payload', 'restored-payload', 'aborted', 'empty'])

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

function syncFileBestEffort(fd) {
  try {
    fs.fsyncSync(fd)
    return { ok: true }
  } catch (error) {
    // Some filesystems/platforms do not implement fsync for regular files.
    // Only those well-known "not supported" errors are downgraded; real I/O
    // failures (EIO/ENOSPC/EDQUOT/…) must not be mistaken for success.
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EBADF'].includes(error?.code)) {
      return { ok: false, unsupported: true, code: error.code }
    }
    throw error
  }
}

function syncDirectoryBestEffort(dir) {
  if (process.platform === 'win32') return { ok: false, unsupported: true, code: 'windows-directory-fsync' }
  let fd
  try {
    fd = fs.openSync(dir, 'r')
    fs.fsyncSync(fd)
    return { ok: true }
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EBADF', 'EACCES'].includes(error?.code)) {
      return { ok: false, unsupported: true, code: error.code }
    }
    return { ok: false, error: error?.code ?? String(error) }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function writeJsonAtomic(file, value, { syncDirectory = true } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  let fileSync = { ok: false, unsupported: true }
  let directorySync = { ok: false, unsupported: true }
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    const fd = fs.openSync(tmp, 'r+')
    try {
      fileSync = syncFileBestEffort(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
    if (syncDirectory) directorySync = syncDirectoryBestEffort(path.dirname(file))
    return {
      ok: true,
      durable: fileSync.ok === true,
      directoryDurable: directorySync.ok === true,
      unsupported: fileSync.unsupported === true || directorySync.unsupported === true,
    }
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
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!SESSION_LOG_RE.test(entry.name)) continue
      if (entry.isFile()) return true
      if (entry.isSymbolicLink()) continue
      // A directory whose *name* merely looks like a log is not a session log.
      const stat = lstatOrNull(path.join(dir, entry.name))
      if (stat?.isFile()) return true
    }
    return false
  } catch {
    return false
  }
}

function safeJsonLine(buffer) {
  const newline = buffer.indexOf(0x0a)
  const line = (newline >= 0 ? buffer.subarray(0, newline) : buffer).toString('utf8').trim()
  if (!line || line.length > MAX_LOG_LINE_BYTES) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * Decode the first Zstandard frame of a session artifact.
 *
 * DSH writes the header as its own zstd frame followed by event frames. Reading
 * a fixed prefix of a large file therefore ends in the middle of a later frame;
 * `zstdDecompressSync` refuses a truncated stream. Locate the next frame magic
 * and decode only the first frame. A false-positive magic inside compressed
 * data is harmless because we try candidates until one decodes.
 */
function decompressFirstZstdFrame(buffer) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const candidates = [buffer]
  let offset = buffer.indexOf(magic, 4)
  while (offset > 0 && candidates.length < 8) {
    candidates.unshift(buffer.subarray(0, offset))
    offset = buffer.indexOf(magic, offset + 4)
  }
  for (const candidate of candidates) {
    try {
      const decoded = zlib.zstdDecompressSync(candidate, { maxOutputLength: MAX_LOG_LINE_BYTES * 2 })
      if (decoded && decoded.length) return decoded
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/**
 * Recover the session header from the on-disk artifact itself.
 *
 * The persistence index can be temporarily unavailable; the first JSONL line
 * is still the authoritative identity written by the host. This is only used
 * for identity/verification, never to decide a path.
 */
function readSessionHeaderFromDir(dir, id) {
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_LOG_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return null
  }
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const stat = fs.statSync(file)
      const limit = Math.min(stat.size, 512 * 1024)
      if (limit <= 0) continue
      const fd = fs.openSync(file, 'r')
      let buffer
      try {
        buffer = Buffer.alloc(limit)
        fs.readSync(fd, buffer, 0, limit, 0)
      } finally {
        fs.closeSync(fd)
      }
      if (name.endsWith('.zstd')) {
        const decoded = decompressFirstZstdFrame(buffer)
        if (!decoded) continue
        buffer = decoded
      }
      const header = safeJsonLine(buffer)
      if (
        header &&
        header.type === 'session' &&
        typeof header.id === 'string' &&
        Number.isSafeInteger(header.version) &&
        Number.isSafeInteger(header.createdAt) &&
        (id === undefined || header.id === id)
      ) {
        return header
      }
    } catch {
      /* try the next artifact */
    }
  }
  return null
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

function describeConfigValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'string') return `string(${safeString(value, 80)})`
  if (typeof value === 'number') return `number(${value})`
  if (typeof value === 'boolean') return `boolean(${value})`
  return typeof value
}

function parseConfig(config) {
  const errors = []
  const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    errors.push({ key: '<config>', expected: 'object', got: describeConfigValue(config) })
  }
  const present = (key) => Object.prototype.hasOwnProperty.call(c, key) && c[key] !== undefined && c[key] !== null
  const bool = (key, fallback) => {
    if (!present(key)) return fallback
    if (typeof c[key] !== 'boolean') {
      errors.push({ key, expected: 'boolean', got: describeConfigValue(c[key]) })
      return fallback
    }
    return c[key]
  }
  const int = (key, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
    if (!present(key)) return fallback
    const value = c[key]
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push({ key, expected: 'integer', got: describeConfigValue(value) })
      return fallback
    }
    if (value < min || value > max) {
      errors.push({ key, expected: `integer in [${min}, ${max}]`, got: describeConfigValue(value) })
      return fallback
    }
    return value
  }
  const str = (key, fallback) => {
    if (!present(key)) return fallback
    if (typeof c[key] !== 'string' || !c[key].trim()) {
      errors.push({ key, expected: 'non-empty string', got: describeConfigValue(c[key]) })
      return fallback
    }
    return c[key].trim()
  }
  const pathString = (key) => {
    if (!present(key)) return null
    if (typeof c[key] !== 'string' || !c[key].trim()) {
      errors.push({ key, expected: 'non-empty absolute path string', got: describeConfigValue(c[key]) })
      return null
    }
    return c[key].trim()
  }
  let protectedSessionIds = []
  if (present('protectedSessionIds')) {
    if (!Array.isArray(c.protectedSessionIds)) {
      errors.push({ key: 'protectedSessionIds', expected: 'array of session id strings', got: describeConfigValue(c.protectedSessionIds) })
    } else {
      for (const value of c.protectedSessionIds) {
        if (typeof value !== 'string' || !value.trim()) {
          errors.push({ key: 'protectedSessionIds', expected: 'array of non-empty session id strings', got: describeConfigValue(value) })
          continue
        }
        protectedSessionIds.push(value.trim())
      }
      protectedSessionIds = [...new Set(protectedSessionIds)]
    }
  }
  const policy = {
    enabled: bool('enabled', true),
    trashKeepDays: int('trashKeepDays', 30, 0, 36500),
    allowPurge: bool('allowPurge', true),
    allowSubagentDelete: bool('allowSubagentDelete', true),
    protectPinned: bool('protectPinned', false),
    protectArchived: bool('protectArchived', false),
    protectedSessionIds,
    maxBatchSize: int('maxBatchSize', 50, 1, 1000),
    maxPending: int('maxPending', 500, 1, 10000),
    requireTypedConfirmAt: int('requireTypedConfirmAt', 3, 1, 10000),
    purgeConfirmWord: str('purgeConfirmWord', 'PURGE'),
    processPendingOnStartup: bool('processPendingOnStartup', false),
    trashSweepIntervalHours: int('trashSweepIntervalHours', 6, 0, 24 * 365),
    logMaxBytes: int('logMaxBytes', 5 * 1024 * 1024, 0, 1024 * 1024 * 1024),
    logKeepFiles: int('logKeepFiles', 3, 1, 10),
    dshHome: pathString('dshHome'),
    sessionsRoot: pathString('sessionsRoot'),
    // Normal deletes must be anchored to a host-written session header. Set to
    // false only for an intentional recovery of a damaged/legacy directory.
    requireVerifiedSession: bool('requireVerifiedSession', true),
    // Strong audit mode: a permanent delete is refused if its intent cannot be
    // appended durably to the audit log. Restore stays available.
    auditRequiredForPurge: bool('auditRequiredForPurge', true),
  }
  return { ...policy, configErrors: errors }
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
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 })
    HOME = realpathNative(HOME)
  } catch (error) {
    throw new HttpError(500, 'bad-home', `DSH_HOME 解析失败：${safeString(error?.message ?? error)}`)
  }
  let DATA_DIR = path.join(HOME, 'session-manager')
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    assertNoSymlinkAncestors(DATA_DIR, HOME)
    const stat = lstatOrNull(DATA_DIR)
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('session-manager 不是真实目录')
    DATA_DIR = realpathNative(DATA_DIR)
  } catch (error) {
    throw new HttpError(500, 'unsafe-root', `插件数据目录不安全（${safeString(error?.message ?? error)}），已拒绝启动`)
  }
  const TRASH_DIR = path.join(DATA_DIR, 'trash')
  const PENDING_FILE = path.join(DATA_DIR, 'pending.json')
  const REPAIR_FILE = path.join(DATA_DIR, 'repair.json')
  const LOG_FILE = path.join(DATA_DIR, 'log.jsonl')
  const PROJ_CACHE_DIR = path.join(HOME, 'storages', 'session_projcache', 'sessions')
  const WORKSPACE_JSON = path.join(HOME, 'storages', 'workspace.json')
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 })
    assertNoSymlinkAncestors(TRASH_DIR, DATA_DIR)
    const trashStat = lstatOrNull(TRASH_DIR)
    if (!trashStat?.isDirectory() || trashStat.isSymbolicLink()) throw new Error('trash 不是真实目录')
  } catch (error) {
    throw new HttpError(500, 'unsafe-root', `回收站目录不安全（${safeString(error?.message ?? error)}），已拒绝启动`)
  }

  const POLICY_MESSAGES = {
    disabled: '插件已被配置为只读（enabled: false），任何删除都被拒绝',
    'config-invalid': '插件配置无效（类型或范围错误），已按 fail-closed 阻止所有删除；请修正配置后重启',
    'purge-disabled': '配置中已禁用彻底删除（allowPurge: false）',
    protected: '这条会话在 protectedSessionIds 名单里，永不允许删除',
    'subagent-protected': '配置中禁止删除子代理会话（allowSubagentDelete: false）',
    'kind-unknown': '无法确认这条会话是主会话还是子代理，而子代理删除已被禁止，已拒绝',
    'pinned-protected': '这条会话已置顶；请先取消置顶（protectPinned: true）',
    'archived-protected': '这条会话已归档；请先取消归档（protectArchived: true）',
    'protection-unknown': '无法读取置顶/归档的权威状态，保护策略无法确认，已拒绝删除（可稍后重试）',
    'identity-unknown': '无法从宿主索引或会话日志确认这条会话的真实身份，已拒绝删除',
    'identity-mismatch': '会话目录的 id 与日志中的宿主身份不一致，已拒绝删除',
    orphan: '这个回收站条目没有可读/一致的 meta.json，无法归属到具体会话，已拒绝处理（保守）',
    incomplete: '这个回收站条目尚未完成搬移，拒绝清理/还原；请先查看启动恢复报告',
    broken: '这个回收站条目缺少 payload 或已损坏，拒绝自动处理（保守）',
    'refs-pending': '这个条目还有未完成的侧边栏引用修复，自动清理已跳过',
    ambiguous: '会话 id 在多个工作区目录中重复，无法安全判定目标，已拒绝处理',
    'projection-too-many': '投影缓存文件数量超过安全上限，已拒绝移动（未做任何删除）',
    'projection-conflict': '还原时投影缓存目标已存在，保留回收站副本并标记为部分还原',
    'unsafe-root': '数据目录包含符号链接/联接或不在 DSH_HOME 内，已拒绝写入',
    'root-changed': '会话根目录已变更；默认拒绝还原，需显式选择迁移到当前根目录',
    occupied: '目标位置已有同名目录，未做还原',
    stale: '界面预览的内容已变化，请刷新后重新确认',
    'confirm-required': '必须提供与实际数量一致的确认数量',
    'audit-required': '审计日志写入失败，强审计模式下已拒绝彻底删除',
    'pending-corrupt': '排队文件已损坏，已隔离且未覆盖；请检查隔离文件后再操作',
    'repair-full': '修复队列已满，无法记录新的修复任务',
    'workspace-missing': '原工作区已不存在，正文已还原但侧边栏引用未恢复',
    'cross-device': '回收站与会话根不在同一磁盘卷，无法原子移动',
  }
  function throwPolicy(code) {
    throw new HttpError(403, code, POLICY_MESSAGES[code] ?? code)
  }
  if (POLICY.configErrors.length) {
    // Do not silently fall back to permissive defaults. The plugin stays
    // visible for diagnosis, but every mutation is refused by assertEnabled().
    logConfigErrorsOnce()
  }
  function logConfigErrorsOnce() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
      fs.appendFileSync(
        LOG_FILE,
        `${JSON.stringify({
          at: nowIso(),
          action: 'config-invalid',
          version: PLUGIN_VERSION,
          errors: POLICY.configErrors,
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch {
      /* the list response still exposes configErrors */
    }
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
      const logStat = lstatOrNull(LOG_FILE)
      if (logStat?.isSymbolicLink()) throw new Error('审计日志文件是符号链接，拒绝写入')
      // Spread first, then force the immutable audit envelope. An entry (or a
      // nested error object) must never be able to rewrite `at`/`action`.
      const base = {
        ...sanitizeForLog(entry ?? {}),
        at: nowIso(),
        action: typeof entry?.action === 'string' ? entry.action : 'event',
        version: PLUGIN_VERSION,
      }
      let line = JSON.stringify(base)
      if (Buffer.byteLength(line) > MAX_LOG_LINE_BYTES) {
        line = JSON.stringify({
          at: base.at,
          action: base.action,
          version: base.version,
          truncated: true,
          sessionId: base.sessionId,
          entryId: base.entryId,
          code: base.code,
        })
      }
      rotateLogIfNeeded(Buffer.byteLength(line) + 1)
      fs.appendFileSync(LOG_FILE, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      logBytes += Buffer.byteLength(line) + 1
      logWriteError = null
      return true
    } catch (error) {
      logWriteError = safeString(error?.message ?? error)
      return false
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

  /**
   * One liveness snapshot per listing/mutation. Calling sessions.list() once
   * per session made /list O(n²) on large profiles; safety decisions still use
   * the same authoritative service, but read it once.
   */
  function makeLivenessIndex() {
    const sessions = sessionsService()
    if (sessions) {
      if (typeof sessions.get === 'function') {
        return {
          mode: 'get',
          available: true,
          get: (id) => {
            try {
              return sessions.get(id) ? 'live' : 'free'
            } catch {
              return 'unknown'
            }
          },
        }
      }
      if (typeof sessions.list === 'function') {
        try {
          const list = sessions.list()
          if (Array.isArray(list)) {
            const set = new Set()
            for (const item of list) {
              const id = item && (item.id ?? item.sessionId ?? item.session_id)
              if (typeof id === 'string' && id) set.add(id)
            }
            return { mode: 'list', available: true, set }
          }
        } catch {
          /* fall through to unknown */
        }
        return { mode: 'list', available: false, set: new Set() }
      }
      return { mode: 'none', available: false, set: new Set() }
    }
    const agents = service('agents')
    if (agents && typeof agents.get === 'function') {
      return {
        mode: 'agent-get',
        available: true,
        get: (id) => {
          try {
            return agents.get(id) ? 'live' : 'free'
          } catch {
            return 'unknown'
          }
        },
      }
    }
    return { mode: 'none', available: false, set: new Set() }
  }

  function livenessFrom(index, id) {
    if (!index.available) return 'unknown'
    if (index.mode === 'list') return index.set.has(id) ? 'live' : 'free'
    if (typeof index.get === 'function') return index.get(id)
    return 'unknown'
  }

  function liveness(id) {
    return livenessFrom(makeLivenessIndex(), id)
  }

  function liveIdSet(index = makeLivenessIndex()) {
    if (index.mode === 'list') return new Set(index.set)
    return new Set()
  }

  function assertDeletable(id, index = makeLivenessIndex()) {
    const state = livenessFrom(index, id)
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
      if (out.length > 0) {
        const items = out.map((item) => {
          const kind = item && typeof item === 'object' ? item.kind ?? item.type ?? item.name : null
          return typeof kind === 'string' ? safeString(kind, 80) : 'activity'
        })
        return { state: 'active', items }
      }
      return { state: 'clear' }
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
        { activity: result.items?.slice(0, 20) ?? [] },
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

  /**
   * Resolve the projection-cache root without following a symlink/junction.
   * A linked cache directory is a configuration choice we cannot safely
   * distinguish from an escape, so projection operations fail closed.
   */
  function projectionRoot({ create = false } = {}) {
    try {
      assertNoSymlinkAncestors(PROJ_CACHE_DIR, HOME)
      const stat = lstatOrNull(PROJ_CACHE_DIR)
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('投影缓存根不是真实目录')
        return realpathNative(PROJ_CACHE_DIR)
      }
      if (create) {
        fs.mkdirSync(PROJ_CACHE_DIR, { recursive: true, mode: 0o700 })
        assertNoSymlinkAncestors(PROJ_CACHE_DIR, HOME)
        return realpathNative(PROJ_CACHE_DIR)
      }
      return PROJ_CACHE_DIR
    } catch (error) {
      throw new HttpError(409, 'unsafe-root', `投影缓存目录不安全：${safeString(error?.message ?? error)}`)
    }
  }

  function assertWorkspaceSafe({ mustExist = false } = {}) {
    try {
      assertNoSymlinkAncestors(WORKSPACE_JSON, HOME)
    } catch (error) {
      throw new HttpError(409, 'unsafe-root', `workspace.json 路径不安全：${safeString(error?.message ?? error)}`)
    }
    const stat = lstatOrNull(WORKSPACE_JSON)
    if (stat?.isSymbolicLink()) throw new HttpError(409, 'unsafe-root', 'workspace.json 是符号链接，拒绝读写')
    if (mustExist && !stat) throw new HttpError(409, 'workspace-readonly', 'workspace.json 不存在')
    return stat
  }

  function assertHomePath(p) {
    if (typeof p !== 'string' || !p) throw new HttpError(500, 'bad-path', '路径配置为空')
    if (!path.isAbsolute(p)) throw new HttpError(500, 'bad-path', `路径不是绝对路径：${p}`)
    return p
  }
  assertHomePath(HOME)

  // ── 策略 ──────────────────────────────────────────────────────
  function assertEnabled() {
    if (POLICY.configErrors.length) {
      throw new HttpError(503, 'config-invalid', POLICY_MESSAGES['config-invalid'], { errors: POLICY.configErrors })
    }
    if (!POLICY.enabled) throwPolicy('disabled')
  }
  function kindOf(id, meta, explicit) {
    if (explicit === 'main' || explicit === 'subagent' || explicit === 'unknown') return explicit
    if (meta && (meta.kind === 'main' || meta.kind === 'subagent' || meta.kind === 'unknown')) return meta.kind
    return sessionKind(id)
  }
  function policyBlockForId(id, meta, { kind, protection } = {}) {
    if (POLICY.configErrors.length) return 'config-invalid'
    if (!POLICY.enabled) return 'disabled'
    if (POLICY.protectedSessionIds.includes(id)) return 'protected'
    const klass = kindOf(id, meta, kind)
    if (klass === 'subagent' && !POLICY.allowSubagentDelete) return 'subagent-protected'
    if (klass === 'unknown' && !POLICY.allowSubagentDelete) return 'kind-unknown'
    if (POLICY.protectPinned) {
      if (protection && protection.pinnedKnown === false) return 'protection-unknown'
      if (meta && meta.pinned) return 'pinned-protected'
    }
    if (POLICY.protectArchived) {
      if (protection && protection.archivedKnown === false) return 'protection-unknown'
      if (meta && meta.archived) return 'archived-protected'
    }
    return null
  }
  function assertProtectionKnown(snapshot) {
    if (POLICY.protectPinned && !snapshot?.protection?.pinnedKnown) throwPolicy('protection-unknown')
    if (POLICY.protectArchived && !snapshot?.protection?.archivedKnown) throwPolicy('protection-unknown')
  }
  function trashPolicyRejection(meta, { auto = false } = {}) {
    if (POLICY.configErrors.length) return 'config-invalid'
    if (!POLICY.enabled) return 'disabled'
    if (!POLICY.allowPurge) return 'purge-disabled'
    if (!meta || typeof meta !== 'object' || typeof meta.sessionId !== 'string' || !meta.sessionId) return 'orphan'
    if (meta.broken === true) return 'broken'
    if (meta.complete === false || meta.phase === 'prepared' || meta.phase === 'payload-moved' || meta.phase === 'projections-moved') {
      return 'incomplete'
    }
    if (meta.phase === 'restoring-payload' || meta.phase === 'restored-payload') return 'incomplete'
    if (auto && (meta.refsPending === true || meta.phase === 'refs-pending')) return 'refs-pending'
    if (POLICY.protectedSessionIds.includes(meta.sessionId)) return 'protected'
    const klass = kindOf(meta.sessionId, meta)
    if (klass === 'subagent' && !POLICY.allowSubagentDelete) return 'subagent-protected'
    if (klass === 'unknown' && !POLICY.allowSubagentDelete) return 'kind-unknown'
    if (POLICY.protectArchived) {
      if (meta.wasArchivedKnown === false) return 'protection-unknown'
      if (meta.wasArchived === true) return 'archived-protected'
    }
    if (POLICY.protectPinned) {
      if (meta.wasPinnedKnown === false) return 'protection-unknown'
      if (meta.wasPinned === true) return 'pinned-protected'
    }
    return null
  }
  function assertPolicy(id, { forPurge = false, meta = null, kind, protection } = {}) {
    assertEnabled()
    if (forPurge && !POLICY.allowPurge) throwPolicy('purge-disabled')
    const code = policyBlockForId(id, meta, { kind, protection })
    if (code) throwPolicy(code)
  }
  function assertBatch(list, confirmCount, label, { requireCount = false } = {}) {
    if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'empty', `${label}：列表不能为空`)
    if (list.length > POLICY.maxBatchSize) {
      throw new HttpError(413, 'too-many', `${label}：单次最多 ${POLICY.maxBatchSize} 条（maxBatchSize）`)
    }
    const strings = list.map((value) => String(value))
    if (new Set(strings).size !== strings.length) throw new HttpError(400, 'duplicate', `${label}：列表包含重复项`)
    if (requireCount && (confirmCount === undefined || confirmCount === null)) {
      throw new HttpError(400, 'confirm-required', `${label}：必须提供确认数量（confirmCount）`)
    }
    if (confirmCount !== undefined && confirmCount !== null) {
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
      assertWorkspaceSafe()
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
    // A structurally invalid document is not a lower-confidence source of
    // protection data. Return empty collections and let callers treat the
    // protection state as unknown.
    if (!validation.valid) return out
    const global = doc.global
    out.workspaceIds = Array.isArray(global.workspaceIds) ? global.workspaceIds.map(String) : []
    out.archived = Array.isArray(global.archivedSessionIds) ? global.archivedSessionIds.filter((x) => typeof x === 'string') : []
    out.pinned = Array.isArray(global.pinnedSessionIds) ? global.pinnedSessionIds.filter((x) => typeof x === 'string') : []
    const table = doc.tables.workspaces
    for (const [id, record] of Object.entries(table)) {
      if (!record || typeof record !== 'object') continue
      out.workspaces.push({
        id,
        path: typeof record.path === 'string' ? record.path : '',
        title: typeof record.title === 'string' ? record.title : '',
        sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds.filter((x) => typeof x === 'string') : [],
      })
    }
    return out
  }

  function workspaceSnapshot() {
    const raw = readIndex()
    const registry = getWorkspaceRegistry()
    const warnings = []
    const registryAttempted = Boolean(registry && typeof registry.list === 'function')
    if (registryAttempted) {
      try {
        const entities = registry.list()
        if (Array.isArray(entities)) {
          let workspaces = []
          try {
            workspaces = entities.map((workspace) => ({
              id: String(workspace.id ?? ''),
              path: typeof workspace.path === 'string' ? workspace.path : '',
              title: typeof workspace.title === 'string' ? workspace.title : '',
              sessionIds: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
            }))
          } catch (error) {
            warnings.push(`workspaceRegistry 工作区列表读取失败：${safeString(error?.message ?? error, 500)}`)
          }
          const protection = {
            workspacesKnown: workspaces.length > 0 || entities.length === 0,
            pinnedKnown: false,
            archivedKnown: false,
            source: 'registry',
          }
          let archived = []
          let pinned = []
          try {
            const value = registry.archivedSessionIds
            if (Array.isArray(value)) {
              archived = value.map(String)
              protection.archivedKnown = true
            } else {
              warnings.push('workspaceRegistry.archivedSessionIds 不是数组，归档保护状态未知')
            }
          } catch (error) {
            warnings.push(`workspaceRegistry.archivedSessionIds 读取失败：${safeString(error?.message ?? error, 500)}`)
          }
          try {
            const value = registry.pinnedSessionIds
            if (Array.isArray(value)) {
              pinned = value.map(String)
              protection.pinnedKnown = true
            } else {
              warnings.push('workspaceRegistry.pinnedSessionIds 不是数组，置顶保护状态未知')
            }
          } catch (error) {
            warnings.push(`workspaceRegistry.pinnedSessionIds 读取失败：${safeString(error?.message ?? error, 500)}`)
          }
          // File contents are useful for display/history, never as authority
          // while a registry exists.
          if (!protection.archivedKnown && raw.valid) archived = raw.archived
          if (!protection.pinnedKnown && raw.valid) pinned = raw.pinned
          return {
            source: 'registry',
            registry,
            entities,
            workspaces,
            archived: new Set(archived),
            pinned: new Set(pinned),
            protection,
            raw,
            warnings,
          }
        }
        warnings.push('workspaceRegistry.list() 未返回数组，已按文件回退')
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
      // If a registry was present but unreadable, the file is not an
      // authoritative substitute for protection state.
      protection: {
        workspacesKnown: !registryAttempted && raw.valid,
        pinnedKnown: !registryAttempted && raw.valid,
        archivedKnown: !registryAttempted && raw.valid,
        source: registryAttempted ? 'registry-unavailable' : raw.valid ? 'file' : 'none',
      },
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
      wasArchivedKnown: snapshot.protection.archivedKnown,
      wasPinnedKnown: snapshot.protection.pinnedKnown,
      warnings: [...snapshot.warnings],
    }
  }

  function assertWorkspaceWritable(doc, reason) {
    const validation = validateWorkspaceDoc(doc)
    if (!validation.valid) throw new HttpError(409, 'workspace-readonly', `workspace.json 不可写（${validation.reason}）`)
    if (reason) throw new HttpError(409, 'workspace-readonly', reason)
  }

  function writeWorkspaceDocAtomic(doc, statBefore) {
    assertWorkspaceSafe({ mustExist: true })
    const current = fs.statSync(WORKSPACE_JSON)
    if (statBefore && (current.mtimeMs !== statBefore.mtimeMs || current.size !== statBefore.size)) {
      throw new HttpError(409, 'workspace-changed', 'workspace.json 已被宿主更新，已放弃本次写入')
    }
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
    assertWorkspaceSafe({ mustExist: true })
    const doc = readWorkspaceDocRaw()
    if (!doc) return { changed: false, pending: true, reason: 'missing', warnings: ['workspace.json 不存在，引用摘除未完成'] }
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
    if (!changed) return { changed: false, pending: false }
    writeWorkspaceDocAtomic(doc, statBefore)
    return { changed: true, pending: false, strategy: 'file' }
  }

  function addRefsFallback(sessionId, meta) {
    assertWorkspaceSafe({ mustExist: true })
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
    let workspaceMissing = false
    if (target && typeof target === 'object') {
      if (!Array.isArray(target.sessionIds)) target.sessionIds = []
      if (!target.sessionIds.includes(sessionId)) {
        target.sessionIds.unshift(sessionId)
        target.updatedAt = nowIso()
        changed = true
      }
    } else if (meta.wasListed !== false) {
      workspaceMissing = true
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
    return { changed, workspaceMissing }
  }

  async function detachRefs(id, captured) {
    const registry = captured?.snapshot?.registry ?? getWorkspaceRegistry()
    if (registry && typeof registry.list === 'function') {
      let changed = false
      const warnings = []
      let pending = false
      let workspaces
      try {
        workspaces = registry.list()
      } catch (error) {
        throw new HttpError(500, 'refs-failed', `读取工作区失败：${safeString(error?.message ?? error)}`)
      }
      const ownerIds = new Set()
      if (captured?.workspaceId) ownerIds.add(String(captured.workspaceId))
      for (const workspace of workspaces) {
        if (!workspace || typeof workspace.id !== 'string') continue
        let rawListed = false
        let getterListed = false
        try {
          rawListed = Boolean(
            captured?.snapshot?.raw?.workspaces?.some((entry) => entry.id === workspace.id && entry.sessionIds.includes(id)),
          )
        } catch {
          /* ignore */
        }
        try {
          getterListed = Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)
        } catch {
          warnings.push(`工作区 ${workspace.id} 的 sessionIds 读取失败，引用摘除待重试`)
          pending = true
        }
        if (rawListed || getterListed) ownerIds.add(workspace.id)
      }
      for (const workspace of workspaces) {
        if (!workspace || !ownerIds.has(workspace.id)) continue
        if (typeof workspace.detachSession !== 'function') {
          warnings.push(`工作区 ${workspace.id} 不支持 detachSession，引用摘除待重试`)
          pending = true
          continue
        }
        try {
          await workspace.detachSession(id)
          changed = true
        } catch (error) {
          throw new HttpError(500, 'refs-failed', `卸载工作区引用失败：${safeString(error?.message ?? error)}`)
        }
      }
      if (captured?.wasArchived) {
        if (typeof registry.unarchiveSession === 'function') {
          await registry.unarchiveSession(id)
          changed = true
        } else {
          warnings.push('workspaceRegistry 不支持 unarchiveSession，归档状态待重试')
          pending = true
        }
      }
      if (captured?.wasPinned) {
        if (typeof registry.unpinSession === 'function') {
          await registry.unpinSession(id)
          changed = true
        } else {
          warnings.push('workspaceRegistry 不支持 unpinSession，置顶状态待重试')
          pending = true
        }
      }
      return { changed, pending, strategy: 'registry', warnings }
    }
    if (captured?.wasListed === false) {
      // Nothing was listed in a workspace document; with no registry there is
      // no reference to detach. Do not leave a permanent refsPending marker.
      return { changed: false, pending: false, strategy: 'none', warnings: [] }
    }
    const result = removeRefsFallback([id])
    return { ...result, strategy: 'file' }
  }

  async function attachRefs(id, meta) {
    const warnings = []
    const registry = getWorkspaceRegistry()
    let attached = false
    let changed = false
    let reason = null
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
      if (meta.wasListed !== false) {
        if (!workspace) {
          warnings.push(POLICY_MESSAGES['workspace-missing'])
          reason = 'workspace-missing'
        } else if (typeof workspace.attachSession !== 'function') {
          warnings.push('工作区不支持 attachSession，引用未恢复')
          reason = 'attach-unavailable'
        } else {
          try {
            await workspace.attachSession(id)
            attached = true
            changed = true
          } catch (error) {
            warnings.push(`恢复工作区引用失败：${safeString(error?.message ?? error, 500)}`)
            reason = 'attach-failed'
          }
        }
      }
      if (meta.wasArchived === true) {
        if (typeof registry.archiveSession === 'function') {
          try {
            await registry.archiveSession(id)
            changed = true
          } catch (error) {
            warnings.push(`恢复归档状态失败：${safeString(error?.message ?? error, 500)}`)
            reason = reason ?? 'archive-failed'
          }
        } else {
          warnings.push('workspaceRegistry 不支持 archiveSession，归档状态未恢复')
          reason = reason ?? 'archive-unavailable'
        }
      } else if (meta.wasPinned === true) {
        if (typeof registry.pinSession === 'function') {
          try {
            await registry.pinSession(id)
            changed = true
          } catch (error) {
            warnings.push(`恢复置顶状态失败：${safeString(error?.message ?? error, 500)}`)
            reason = reason ?? 'pin-failed'
          }
        } else {
          warnings.push('workspaceRegistry 不支持 pinSession，置顶状态未恢复')
          reason = reason ?? 'pin-unavailable'
        }
      }
      if (meta.wasListed === false && !attached) {
        // Nothing to attach is a valid no-op; do not claim a change.
      }
      return { changed, attached, strategy: 'registry', warnings, reason }
    }
    try {
      const result = addRefsFallback(id, meta)
      if (result.workspaceMissing) {
        warnings.push(POLICY_MESSAGES['workspace-missing'])
        reason = 'workspace-missing'
      }
      return { ...result, attached: false, strategy: 'file', warnings, reason }
    } catch (error) {
      warnings.push(`恢复 workspace.json 引用失败：${safeString(error?.message ?? error, 500)}`)
      return { changed: false, attached: false, strategy: 'file', warnings, reason: 'workspace-failed' }
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

  function findSessionDir(id, presetScan = null) {
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) throw new HttpError(400, 'bad-id', '会话 id 不合法')
    const scan = presetScan ?? scanSessionDirs()
    if (scan.ambiguous.has(id)) throw new HttpError(409, 'ambiguous', POLICY_MESSAGES.ambiguous)
    const found = scan.dirs.get(id)
    if (!found) {
      if (presetScan) return findSessionDir(id)
      throw new HttpError(404, 'not-found', '这条会话在磁盘上不存在（可能已被删除）')
    }
    // A preset scan is only a batching hint; the directory must still be a
    // real, log-bearing directory at the moment of use.
    if (presetScan && (!isRealDirectory(found.dir) || !looksLikeSessionDir(found.dir))) {
      return findSessionDir(id)
    }
    return { ...found, scan }
  }

  function projectTitle(id) {
    let file
    try {
      file = path.join(projectionRoot(), `${id}.json`)
    } catch {
      return { title: '', cwd: '' }
    }
    const rec = readJsonSafe(file)
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
    let persistenceOk = false
    let sessionsOk = false
    let persistenceError = null
    if (persistence && typeof persistence.list === 'function') {
      try {
        const snapshots = await persistence.list()
        if (Array.isArray(snapshots)) {
          persistenceOk = true
          for (const snapshot of snapshots) {
            const header = snapshot?.header
            if (!header || typeof header.id !== 'string') continue
            map.set(header.id, header)
            if (Number.isFinite(snapshot.sizeBytes)) sizes.set(header.id, Number(snapshot.sizeBytes))
          }
        } else {
          persistenceError = 'sessionPersistence.list() 未返回数组'
          warnings.push(persistenceError)
        }
      } catch (error) {
        persistenceError = safeString(error?.message ?? error, 500)
        warnings.push(`sessionPersistence.list() 失败，标题/归属与身份核对降级：${persistenceError}`)
      }
    }
    const sessions = sessionsService()
    if (sessions && typeof sessions.list === 'function') {
      try {
        const list = sessions.list()
        if (Array.isArray(list)) {
          sessionsOk = true
          for (const item of list) {
            const header = item?.header
            if (header && typeof header.id === 'string' && !map.has(header.id)) map.set(header.id, header)
          }
        }
      } catch {
        /* ignore: the live service is optional */
      }
    }
    return {
      map,
      sizes,
      warnings,
      source: persistenceOk ? 'sessionPersistence' : sessionsOk ? 'sessions' : 'none',
      ok: persistenceOk || sessionsOk,
      persistenceOk,
      sessionsOk,
      persistenceError,
    }
  }

  function storedHeaderFor(id, stored) {
    return stored?.map?.get(id) ?? null
  }

  function resolveSessionIdentity(id, found, stored) {
    const indexed = storedHeaderFor(id, stored)
    const onDisk = indexed ? null : readSessionHeaderFromDir(found.dir, id)
    const header = indexed ?? onDisk
    return {
      header,
      source: indexed ? 'index' : onDisk ? 'log' : 'none',
      verified: Boolean(header && header.id === id),
    }
  }

  function classifySession(id, header) {
    if (header?.origin === 'subagent' || header?.parentSession) return 'subagent'
    if (header && header.id === id) return 'main'
    if (SESSION_ID_RE.test(id)) return 'main'
    return 'unknown'
  }

  function listSessions() {
    // Synchronous scan + one async header read. Every expensive per-session
    // walk is avoided when the persistence index already has the size.
    return (async () => {
      const snapshot = workspaceSnapshot()
      const scan = scanSessionDirs()
      const stored = await readStoredHeaders()
      const livenessIndex = makeLivenessIndex()
      const warnings = [...snapshot.warnings, ...stored.warnings]
      const childCounts = new Map()
      for (const header of stored.map.values()) {
        if (typeof header?.parentSession === 'string' && header.parentSession) {
          childCounts.set(header.parentSession, (childCounts.get(header.parentSession) ?? 0) + 1)
        }
      }
      const sessions = []
      for (const [id, found] of scan.dirs) {
        const header = stored.map.get(id) ?? readSessionHeaderFromDir(found.dir, id)
        const meta = projectTitle(id)
        const cwd = typeof header?.cwd === 'string' && header.cwd ? header.cwd : meta.cwd
        const owner = findWorkspaceForSession(id, snapshot) ?? findWorkspaceForCwd(cwd, snapshot)
        const state = livenessFrom(livenessIndex, id)
        const kind = classifySession(id, header)
        const archived = snapshot.archived.has(id)
        const pinned = snapshot.pinned.has(id)
        const knownBytes = stored.sizes.get(id)
        const sizes = Number.isFinite(knownBytes) ? null : sessionDirBytes(found.dir)
        const identityRequired = POLICY.requireVerifiedSession && !header
        const blockedReason =
          POLICY.configErrors.length
            ? 'config-invalid'
            : scan.ambiguous.has(id)
              ? 'ambiguous'
              : state !== 'free'
                ? state
                : identityRequired
                  ? 'identity-unknown'
                  : policyBlockForId(id, { pinned, archived, kind }, { kind, protection: snapshot.protection })
        sessions.push({
          id,
          dirName: found.dirName,
          kind,
          blockedReason,
          deletable: blockedReason === null,
          bytes: Number.isFinite(knownBytes) ? knownBytes : sizes.bytes,
          updatedAt: (sizes ? sizes.updatedAt : null) ?? sessionDirMtime(found.dir),
          title: meta.title,
          workspacePath: owner?.path || cwd || '',
          workspaceTitle: owner?.title ?? '',
          workspaceId: owner?.id ?? '',
          listed: Boolean(owner && owner.sessionIds.includes(id)),
          archived,
          pinned,
          liveness: state,
          live: state !== 'free',
          childSessionCount: childCounts.get(id) ?? 0,
          unverified: !header,
          inTrash: false,
        })
      }
      sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      return { snapshot, scan, sessions, warnings, stored, livenessIndex }
    })()
  }

  // ── 回收站 ────────────────────────────────────────────────────
  function isProjectionName(name, sessionId) {
    return (
      typeof name === 'string' &&
      name.length > 0 &&
      name.length <= 255 &&
      name.startsWith(`${sessionId}.json`) &&
      !name.includes('/') &&
      !name.includes('\\') &&
      name !== '.' &&
      name !== '..'
    )
  }

  function normalizeProjectionList(raw, sessionId) {
    if (!Array.isArray(raw)) return { files: [], truncated: false }
    const files = []
    let truncated = false
    for (const name of raw) {
      if (!isProjectionName(name, sessionId)) continue
      if (files.includes(name)) continue
      if (files.length >= MAX_PROJECTION_FILES) {
        truncated = true
        break
      }
      files.push(name)
    }
    return { files, truncated }
  }

  function derivePhase(raw) {
    if (typeof raw?.phase === 'string' && PHASES.has(raw.phase)) return raw.phase
    if (raw?.complete === false) return 'prepared'
    if (raw?.refsPending === true) return 'refs-pending'
    return 'complete'
  }

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
    const projection = normalizeProjectionList(raw.projectionFiles, sessionId)
    const expected = normalizeProjectionList(raw.projectionExpected, sessionId)
    const phase = derivePhase(raw)
    const meta = {
      metaVersion: Number.isInteger(raw.metaVersion) ? raw.metaVersion : 2,
      entryId,
      sessionId,
      sessionDirName,
      workspaceSlug,
      workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
      workspacePath: typeof raw.workspacePath === 'string' ? raw.workspacePath : '',
      sessionsRoot: typeof raw.sessionsRoot === 'string' ? raw.sessionsRoot : '',
      title: safeString(typeof raw.title === 'string' ? raw.title : '', 300),
      originalPath: typeof raw.originalPath === 'string' ? raw.originalPath : '',
      projectionFiles: projection.files,
      projectionExpected: expected.files,
      projectionFilesTruncated: projection.truncated || expected.truncated,
      deletedAt,
      deletedMs,
      bytes: Number.isFinite(Number(raw.bytes)) && Number(raw.bytes) >= 0 ? Number(raw.bytes) : 0,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
      complete: raw.complete !== false,
      phase,
      wasListed: raw.wasListed === true || (raw.wasListed === undefined && Boolean(raw.workspaceId)),
      wasArchived: raw.wasArchived === true,
      wasPinned: raw.wasPinned === true,
      wasArchivedKnown: typeof raw.wasArchived === 'boolean',
      wasPinnedKnown: typeof raw.wasPinned === 'boolean',
      refsPending: raw.refsPending === true,
      refsDetached: raw.refsDetached === true,
      broken: raw.broken === true,
      kind:
        raw.kind === 'main' || raw.kind === 'subagent' || raw.kind === 'unknown' ? raw.kind : undefined,
      requestId: typeof raw.requestId === 'string' ? safeString(raw.requestId, 200) : '',
      restoredAt: typeof raw.restoredAt === 'string' ? raw.restoredAt : '',
      restoreTarget: typeof raw.restoreTarget === 'string' ? raw.restoreTarget : '',
      restoreRoot: typeof raw.restoreRoot === 'string' ? raw.restoreRoot : '',
      attachPending: raw.attachPending === true,
      sessionCreatedAt: Number.isSafeInteger(raw.sessionCreatedAt) ? raw.sessionCreatedAt : null,
      sessionCwd: typeof raw.sessionCwd === 'string' ? raw.sessionCwd : '',
      recovery: typeof raw.recovery === 'string' ? safeString(raw.recovery, 200) : '',
    }
    return { valid: true, reason: null, meta }
  }

  function assertTrashRootSafe() {
    try {
      fs.mkdirSync(TRASH_DIR, { recursive: true, mode: 0o700 })
      assertNoSymlinkAncestors(TRASH_DIR, DATA_DIR)
      const stat = lstatOrNull(TRASH_DIR)
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('trash 不是真实目录')
    } catch (error) {
      throw new HttpError(409, 'unsafe-root', `回收站目录不安全：${safeString(error?.message ?? error)}`)
    }
  }

  function readTrashEntry(entryId) {
    if (typeof entryId !== 'string' || !TRASH_ENTRY_ID_RE.test(entryId)) {
      throw new HttpError(400, 'bad-entry', '回收站条目 id 不合法')
    }
    assertTrashRootSafe()
    const dir = path.join(TRASH_DIR, entryId)
    const stat = lstatOrNull(dir)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new HttpError(404, 'not-found', '回收站里没有这个条目')
    }
    assertNoSymlinkAncestors(dir, TRASH_DIR)
    const raw = readJsonSafe(path.join(dir, 'meta.json'))
    return { entryId, dir, raw, ...normalizeMeta(entryId, raw) }
  }

  function scanTrashEntries() {
    const entries = []
    try {
      assertTrashRootSafe()
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

  function projectionDirOf(entry) {
    return path.join(entry.dir, 'projection')
  }

  function listProjectionDir(entry) {
    const dir = projectionDirOf(entry)
    if (!isRealDirectory(dir)) return []
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isFile() && !item.isSymbolicLink())
        .map((item) => item.name)
    } catch {
      return []
    }
  }

  function restoredTargetExists(meta) {
    if (!meta) return ''
    const candidates = [meta.restoreTarget, meta.originalPath].filter(
      (value) => typeof value === 'string' && value && path.isAbsolute(value),
    )
    for (const candidate of candidates) {
      if (!isRealDirectory(candidate)) continue
      try {
        const header = readSessionHeaderFromDir(candidate, meta.sessionId)
        if (header?.id === meta.sessionId) {
          if (meta.sessionCreatedAt === null || header.createdAt === meta.sessionCreatedAt) return candidate
          continue
        }
        if (!header && looksLikeSessionDir(candidate)) return candidate
      } catch {
        /* try the next candidate */
      }
    }
    return ''
  }

  /**
   * Re-inspect the actual on-disk shape at operation time. `broken` in meta is
   * only a hint written by startup recovery; it must never be the sole reason a
   * structurally broken entry is purged.
   */
  function inspectTrashEntry(entry) {
    const meta = entry?.meta
    const payloadExists = Boolean(entry?.valid && isRealDirectory(payloadOf(entry)))
    const projectionFiles = entry?.valid ? listProjectionDir(entry) : []
    const phase = meta?.phase ?? 'unknown'
    const expectedPayload = phase !== 'restored-payload' && phase !== 'aborted' && phase !== 'empty'
    const restoredTarget = expectedPayload && !payloadExists ? restoredTargetExists(meta) : ''
    const broken =
      !entry?.valid ||
      meta?.broken === true ||
      (expectedPayload && !payloadExists && !restoredTarget) ||
      phase === 'aborted' ||
      phase === 'empty'
    const incomplete =
      meta?.complete === false ||
      phase === 'prepared' ||
      phase === 'payload-moved' ||
      phase === 'projections-moved' ||
      phase === 'restoring-payload'
    return {
      payloadExists,
      projectionFiles,
      phase,
      restoredTarget,
      broken,
      incomplete,
      refsPending: meta?.refsPending === true || phase === 'refs-pending',
    }
  }

  function removeTrashDir(entryId) {
    if (typeof entryId !== 'string' || !TRASH_ENTRY_ID_RE.test(entryId)) {
      throw new HttpError(400, 'bad-entry', '回收站条目 id 不合法')
    }
    assertTrashRootSafe()
    const target = path.join(TRASH_DIR, entryId)
    if (!isPathInside(target, TRASH_DIR)) throw new HttpError(403, 'bad-entry', '条目路径越界')
    assertNoSymlinkAncestors(target, TRASH_DIR)
    const stat = lstatOrNull(target)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new HttpError(404, 'not-found', '回收站里没有这个条目')
    }
    fs.rmSync(target, { recursive: true, force: true })
    syncDirectoryBestEffort(TRASH_DIR)
  }

  function removeTrashEntry(entry) {
    if (!entry) throw new HttpError(403, 'orphan', POLICY_MESSAGES.orphan)
    removeTrashDir(entry.entryId)
  }

  function moveProjectionFiles(id, entryDir, progress) {
    const root = projectionRoot()
    const names = []
    if (!isRealDirectory(root)) return names
    let stat
    try {
      stat = fs.lstatSync(root)
    } catch {
      return names
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new HttpError(409, 'unsafe-root', '投影缓存根不是真实目录，拒绝移动')
    }
    try {
      for (const name of fs.readdirSync(root)) {
        if (!isProjectionName(name, id)) continue
        const from = path.join(root, name)
        const fileStat = lstatOrNull(from)
        if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) continue
        names.push(name)
      }
      if (names.length > MAX_PROJECTION_FILES) {
        throw new HttpError(413, 'projection-too-many', `投影缓存文件 ${names.length} 个，超过上限 ${MAX_PROJECTION_FILES}；未做任何删除`)
      }
      if (!names.length) return names
      const projectionDir = projectionDirOf({ dir: entryDir })
      fs.mkdirSync(projectionDir, { recursive: true, mode: 0o700 })
      assertNoSymlinkAncestors(projectionDir, entryDir)
      for (const name of names) {
        fs.renameSync(path.join(root, name), path.join(projectionDir, name))
        progress.moved.push(name)
      }
      return names
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(500, 'projection-failed', `移动投影缓存失败：${safeString(error?.message ?? error)}`, {
        moved: [...progress.moved],
      })
    }
  }

  function restoreProjectionFiles(meta, entryDir) {
    const warnings = []
    const conflicts = []
    const missing = []
    const restored = []
    const projectionDir = projectionDirOf({ dir: entryDir })
    let root
    try {
      root = projectionRoot({ create: true })
    } catch (error) {
      return {
        warnings: [safeString(error?.message ?? error, 500)],
        conflicts,
        missing,
        restored,
        remaining: [],
        partial: true,
      }
    }
    const names = new Set()
    for (const name of meta.projectionFiles) {
      if (isProjectionName(name, meta.sessionId)) names.add(name)
    }
    for (const name of listProjectionDir({ dir: entryDir })) {
      if (isProjectionName(name, meta.sessionId)) names.add(name)
    }
    const ordered = [...names]
    const bounded = ordered.slice(0, MAX_PROJECTION_FILES)
    const remaining = ordered.slice(MAX_PROJECTION_FILES)
    if (remaining.length) warnings.push(`投影缓存文件超过 ${MAX_PROJECTION_FILES} 个，先恢复前 ${MAX_PROJECTION_FILES} 个`)
    for (const name of bounded) {
      const from = path.join(projectionDir, name)
      const to = path.join(root, name)
      const stat = lstatOrNull(from)
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        if (lstatOrNull(to)) {
          // A previous attempt already moved this file; treat it as restored
          // rather than a permanent conflict.
          restored.push(name)
        } else {
          missing.push(name)
        }
        continue
      }
      if (lstatOrNull(to)) {
        conflicts.push(name)
        warnings.push(`投影缓存目标已存在，跳过：${name}`)
        continue
      }
      try {
        assertNoSymlinkAncestors(root, HOME)
        fs.renameSync(from, to)
        restored.push(name)
      } catch (error) {
        warnings.push(`恢复投影缓存失败：${name}：${safeString(error?.message ?? error, 300)}`)
      }
    }
    return {
      warnings,
      conflicts,
      missing,
      restored,
      remaining,
      partial: conflicts.length > 0 || missing.length > 0 || remaining.length > 0 || restored.length !== bounded.length,
    }
  }

  // ── 移动/还原/清理 ─────────────────────────────────────────────
  function directoryFingerprint(dir) {
    const stat = lstatOrNull(dir)
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return null
    return {
      dev: String(stat.dev ?? ''),
      ino: String(stat.ino ?? ''),
      real: (() => {
        try {
          return realpathNative(dir)
        } catch {
          return ''
        }
      })(),
    }
  }
  function sameDirectoryFingerprint(left, right) {
    if (!left || !right) return false
    if (left.real && right.real && !isSamePath(left.real, right.real)) return false
    if (left.ino && right.ino && left.ino !== '0' && right.ino !== '0' && left.ino !== right.ino) return false
    if (left.dev && right.dev && left.dev !== right.dev) return false
    return true
  }

  function metaPathOf(entry) {
    return path.join(entry.dir, 'meta.json')
  }

  function patchMeta(entry, patch) {
    const current = readJsonSafe(metaPathOf(entry))
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new HttpError(500, 'bad-meta', '回收站 meta.json 不可读，无法更新事务阶段')
    }
    const next = { ...current, ...patch, metaVersion: META_VERSION }
    writeJsonAtomic(metaPathOf(entry), next)
    entry.raw = next
    const normalized = normalizeMeta(entry.entryId, next)
    if (normalized.valid) entry.meta = normalized.meta
    return next
  }

  function findTrashByRequestId(sessionId, requestId) {
    if (!requestId) return null
    return (
      validTrashEntries().find(
        (entry) => entry.meta.sessionId === sessionId && entry.meta.requestId === requestId,
      ) ?? null
    )
  }

  function listProjectionNames(id) {
    const root = projectionRoot()
    if (!isRealDirectory(root)) return []
    const names = []
    for (const name of fs.readdirSync(root)) {
      if (!isProjectionName(name, id)) continue
      const stat = lstatOrNull(path.join(root, name))
      if (stat?.isFile() && !stat.isSymbolicLink()) names.push(name)
    }
    if (names.length > MAX_PROJECTION_FILES) {
      throw new HttpError(413, 'projection-too-many', `投影缓存文件 ${names.length} 个，超过上限 ${MAX_PROJECTION_FILES}；未做任何删除`)
    }
    return names
  }

  function rollbackMove(entry, metaDoc, progress) {
    const conflicts = []
    let ok = true
    const payload = path.join(entry.dir, 'payload')
    const source = metaDoc.originalPath
    try {
      if (isRealDirectory(payload)) {
        if (lstatOrNull(source)) {
          conflicts.push({ kind: 'payload', target: source })
          ok = false
        } else {
          fs.renameSync(payload, source)
          syncDirectoryBestEffort(path.dirname(source))
        }
      }
    } catch {
      ok = false
      conflicts.push({ kind: 'payload', target: source, error: true })
    }
    const projectionDir = projectionDirOf(entry)
    const movedNames = new Set(progress.moved)
    for (const name of listProjectionDir(entry)) movedNames.add(name)
    let projectionTarget = null
    try {
      projectionTarget = projectionRoot()
    } catch {
      projectionTarget = null
    }
    for (const name of movedNames) {
      if (!isProjectionName(name, metaDoc.sessionId)) continue
      const from = path.join(projectionDir, name)
      if (!lstatOrNull(from)) continue
      if (!projectionTarget) {
        conflicts.push({ kind: 'projection', name, error: 'unsafe-root' })
        ok = false
        continue
      }
      const to = path.join(projectionTarget, name)
      if (lstatOrNull(to)) {
        conflicts.push({ kind: 'projection', name })
        ok = false
        continue
      }
      try {
        fs.renameSync(from, to)
      } catch {
        ok = false
        conflicts.push({ kind: 'projection', name, error: true })
      }
    }
    if (ok) {
      try {
        fs.rmSync(entry.dir, { recursive: true, force: true })
        return { ok: true, conflicts }
      } catch {
        /* fall through to marking it recoverable */
      }
    }
    try {
      patchMeta(entry, {
        phase: 'aborted',
        complete: false,
        refsPending: false,
        broken: true,
        recovery: conflicts.length ? 'rollback-conflict' : 'rollback-failed',
      })
    } catch {
      /* the caller still reports the entry id */
    }
    return { ok: false, conflicts }
  }

  async function moveToTrash(id, { reason = 'manual', requestId = '', scanHint = null } = {}) {
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) throw new HttpError(400, 'bad-id', '会话 id 不合法')
    const existing = findTrashByRequestId(id, requestId)
    if (existing && (existing.meta.phase === 'prepared' || existing.meta.phase === 'payload-moved')) {
      throw new HttpError(409, 'in-progress', '同一请求的移入回收站操作尚未完成，请稍后重试或刷新列表', {
        entryId: existing.entryId,
      })
    }
    if (existing) {
      return {
        entryId: existing.entryId,
        bytes: existing.meta.bytes,
        refs: existing.meta.refsDetached === true,
        warnings: [],
        committed: true,
        idempotent: true,
      }
    }

    let found = findSessionDir(id, scanHint)
    if (found.scan.ambiguous.has(id)) throw new HttpError(409, 'ambiguous', POLICY_MESSAGES.ambiguous)
    assertNoSymlinkAncestors(found.dir, found.scan.root)
    const firstFingerprint = directoryFingerprint(found.dir)
    if (!firstFingerprint) throw new HttpError(409, 'changed', '会话目录在检查期间消失或变成了链接')
    const meta0 = projectTitle(id)
    const captured = captureRefs(id, meta0.cwd)
    assertProtectionKnown(captured.snapshot)

    const stored = await readStoredHeaders()
    const identity = resolveSessionIdentity(id, found, stored)
    if (identity.header && identity.header.id !== id) {
      throw new HttpError(409, 'identity-mismatch', POLICY_MESSAGES['identity-mismatch'])
    }
    if (POLICY.requireVerifiedSession && !identity.verified) {
      throw new HttpError(409, 'identity-unknown', POLICY_MESSAGES['identity-unknown'])
    }
    const kind = classifySession(id, identity.header)
    assertPolicy(id, {
      meta: { pinned: captured.wasPinned, archived: captured.wasArchived, kind },
      kind,
      protection: captured.snapshot.protection,
    })
    assertDeletable(id)
    await assertNoActivity(id)

    // Re-anchor after the asynchronous activity check. This does not close the
    // cross-process TOCTOU completely (only the host can), but it prevents
    // acting on a directory that was replaced or removed while we awaited.
    found = findSessionDir(id)
    if (found.scan.ambiguous.has(id)) throw new HttpError(409, 'ambiguous', POLICY_MESSAGES.ambiguous)
    assertNoSymlinkAncestors(found.dir, found.scan.root)
    if (!sameDirectoryFingerprint(firstFingerprint, directoryFingerprint(found.dir))) {
      throw new HttpError(409, 'changed', '会话目录在检查期间发生了变化，已拒绝删除')
    }
    assertDeletable(id)

    const sizes = Number.isFinite(stored.sizes.get(id))
      ? { bytes: stored.sizes.get(id), updatedAt: sessionDirMtime(found.dir) }
      : sessionDirBytes(found.dir)
    const projectionExpected = listProjectionNames(id)

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17)
    assertTrashRootSafe()
    let entryId = `${stamp}_${id}`
    let suffix = 1
    let entryDir = path.join(TRASH_DIR, entryId)
    for (;;) {
      try {
        fs.mkdirSync(entryDir, { mode: 0o700 })
        break
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw new HttpError(500, 'move-failed', `创建回收站条目失败：${safeString(error?.message ?? error)}`)
        }
        entryId = `${stamp}_${suffix++}_${id}`
        entryDir = path.join(TRASH_DIR, entryId)
        if (suffix > 1000) throw new HttpError(409, 'entry-collision', '回收站条目 id 冲突过多，请稍后重试')
      }
    }
    assertNoSymlinkAncestors(entryDir, TRASH_DIR)
    if (lstatOrNull(path.join(entryDir, 'payload'))) {
      throw new HttpError(409, 'entry-collision', '回收站条目已存在 payload，拒绝覆盖')
    }

    const sessionsRootInfo = resolveSessionsRootInfo()
    const metaDoc = {
      metaVersion: META_VERSION,
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
      projectionExpected,
      deletedAt: nowIso(),
      deletedMs: Date.now(),
      bytes: sizes.bytes,
      reason,
      complete: false,
      phase: 'prepared',
      wasListed: captured.wasListed,
      wasArchived: captured.wasArchived,
      wasPinned: captured.wasPinned,
      wasArchivedKnown: captured.wasArchivedKnown,
      wasPinnedKnown: captured.wasPinnedKnown,
      refsPending: false,
      refsDetached: false,
      broken: false,
      kind,
      requestId: safeString(requestId, 200),
      sessionCreatedAt: Number.isSafeInteger(identity.header?.createdAt) ? identity.header.createdAt : null,
      sessionCwd: typeof identity.header?.cwd === 'string' ? identity.header.cwd : '',
      pluginVersion: PLUGIN_VERSION,
    }
    const metaPath = metaPathOf({ dir: entryDir })
    try {
      writeJsonAtomic(metaPath, metaDoc)
    } catch (error) {
      try {
        fs.rmSync(entryDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      throw new HttpError(500, 'move-failed', `写入回收站元数据失败：${safeString(error?.message ?? error)}`)
    }

    const entry = { entryId, dir: entryDir, raw: metaDoc, meta: normalizeMeta(entryId, metaDoc).meta }
    const progress = { moved: [] }
    try {
      fs.renameSync(found.dir, path.join(entryDir, 'payload'))
      syncDirectoryBestEffort(path.dirname(found.dir))
      syncDirectoryBestEffort(entryDir)
      patchMeta(entry, { phase: 'payload-moved', complete: false })
    } catch (error) {
      const rollback = rollbackMove(entry, metaDoc, progress)
      try {
        if (rollback.ok) fs.rmSync(entryDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      log({ action: 'trash-failed', sessionId: id, entryId, rolledBack: rollback.ok, conflicts: rollback.conflicts, error: String(error?.message ?? error) })
      if (error?.code === 'EXDEV') {
        throw new HttpError(409, 'cross-device', POLICY_MESSAGES['cross-device'], { entryId, committed: false })
      }
      throw new HttpError(
        500,
        'move-failed',
        `移入回收站失败：${safeString(error?.message ?? error)}`,
        { entryId, committed: false, rolledBack: rollback.ok, conflicts: rollback.conflicts },
      )
    }

    // Post-rename claim verification: if a live session or background work
    // appeared while we were awaiting, put the directory back instead of
    // deleting a session that is now in use.
    try {
      assertDeletable(id)
      await assertNoActivity(id)
    } catch (error) {
      const rollback = rollbackMove(entry, metaDoc, progress)
      try {
        if (rollback.ok) fs.rmSync(entryDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      throw new HttpError(
        error instanceof HttpError ? error.status : 409,
        error instanceof HttpError ? error.code : 'active',
        `移入回收站已回滚：${safeString(error?.message ?? error)}`,
        { entryId, committed: false, rolledBack: rollback.ok, conflicts: rollback.conflicts },
      )
    }

    let projections = []
    try {
      projections = moveProjectionFiles(id, entryDir, progress)
      patchMeta(entry, {
        phase: 'projections-moved',
        complete: true,
        projectionFiles: projections,
        refsPending: true,
      })
    } catch (error) {
      const rollback = rollbackMove(entry, metaDoc, progress)
      try {
        if (rollback.ok) fs.rmSync(entryDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      log({ action: 'trash-failed', sessionId: id, entryId, rolledBack: rollback.ok, conflicts: rollback.conflicts, error: String(error?.message ?? error) })
      if (error?.code === 'EXDEV') {
        throw new HttpError(409, 'cross-device', POLICY_MESSAGES['cross-device'], { entryId, committed: false })
      }
      throw new HttpError(
        500,
        'move-failed',
        `移入回收站失败：${safeString(error?.message ?? error)}`,
        { entryId, committed: false, rolledBack: rollback.ok, conflicts: rollback.conflicts },
      )
    }

    // From here on the payload is committed. Every failure is reported as a
    // partial/committed result with entryId, never as an anonymous 500.
    const warnings = [...captured.warnings]
    const failures = []
    let refsResult
    try {
      refsResult = await detachRefs(id, captured)
    } catch (error) {
      refsResult = {
        changed: false,
        pending: true,
        strategy: captured.snapshot.source,
        warnings: [safeString(error?.message ?? error, 500)],
      }
      failures.push({ step: 'refs', code: error instanceof HttpError ? error.code : 'error' })
    }
    warnings.push(...(refsResult.warnings ?? []))
    try {
      patchMeta(entry, {
        phase: refsResult.pending ? 'refs-pending' : 'complete',
        complete: true,
        refsPending: refsResult.pending === true,
        refsDetached: !refsResult.pending,
      })
    } catch (error) {
      warnings.push(`更新回收站事务阶段失败：${safeString(error?.message ?? error, 300)}`)
      failures.push({ step: 'meta-finalize', code: 'meta-failed' })
    }

    try {
      const store = readPendingStore()
      if (store.corrupt) {
        warnings.push('pending.json 已损坏，未覆盖；请检查隔离文件')
        failures.push({ step: 'pending-cleanup', code: 'pending-corrupt' })
      } else {
        writePending(store.items.filter((item) => item.sessionId !== id))
      }
    } catch (error) {
      warnings.push(`清理排队表失败：${safeString(error?.message ?? error, 300)}`)
      failures.push({ step: 'pending-cleanup', code: 'pending-write-failed' })
    }

    if (!log({
      action: 'trash',
      sessionId: id,
      entryId,
      requestId: metaDoc.requestId,
      bytes: sizes.bytes,
      refs: refsResult.changed === true,
      refsStrategy: refsResult.strategy,
      warnings: refsResult.warnings ?? [],
      reason,
    })) {
      warnings.push('审计日志写入失败')
      failures.push({ step: 'audit', code: 'audit-failed' })
    }
    return {
      entryId,
      bytes: sizes.bytes,
      refs: refsResult.changed === true,
      refsPending: refsResult.pending === true,
      warnings,
      failures,
      committed: true,
      idempotent: false,
    }
  }

  function resolveRestoreTarget(meta, rootInfo, { relocate = false } = {}) {
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
    const currentRoot = path.resolve(rootInfo.root)
    const originalRoot =
      typeof meta.sessionsRoot === 'string' && meta.sessionsRoot && path.isAbsolute(meta.sessionsRoot)
        ? path.resolve(meta.sessionsRoot)
        : ''
    let relocated = false
    if (originalRoot && !isSamePath(originalRoot, currentRoot)) {
      if (!relocate) {
        throw new HttpError(
          409,
          'root-changed',
          `会话根已从 ${originalRoot} 变更为 ${currentRoot}；默认不迁移，请显式选择迁移到当前根目录`,
          { originalRoot, currentRoot },
        )
      }
      relocated = true
    }
    try {
      fs.mkdirSync(currentRoot, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new HttpError(500, 'restore-root', `创建会话根失败：${safeString(error?.message ?? error)}`)
    }
    const canonicalRoot = realpathNative(currentRoot)
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
    if (lstatOrNull(target)) throw new HttpError(409, 'occupied', POLICY_MESSAGES.occupied)
    return { target, relocated, originalRoot, currentRoot }
  }

  async function restore(entryId, { relocate = false } = {}) {
    assertEnabled()
    const entry = readTrashEntry(entryId)
    if (!entry.valid) throw new HttpError(409, 'bad-meta', `回收站条目元数据不一致（${entry.reason}）`)
    const inspection = inspectTrashEntry(entry)
    if (entry.meta.phase === 'restored-payload' && inspection.payloadExists) {
      throw new HttpError(409, 'broken', '回收站条目同时存在已还原正文与 payload，状态不一致；请用诊断信息处置')
    }
    const recovering = entry.meta.phase === 'restoring-payload' && Boolean(inspection.restoredTarget)
    if (entry.meta.phase !== 'restored-payload' && !recovering) {
      if (inspection.broken) throw new HttpError(409, 'broken', POLICY_MESSAGES.broken)
      if (inspection.incomplete) throw new HttpError(409, 'incomplete', POLICY_MESSAGES.incomplete)
      if (!inspection.payloadExists) throw new HttpError(409, 'broken', '回收站条目缺少正文，无法还原')
    }
    const warnings = []
    let relocated = false
    if (inspection.payloadExists) {
      const payloadHeader = readSessionHeaderFromDir(payloadOf(entry))
      if (payloadHeader) {
        if (payloadHeader.id !== entry.meta.sessionId) {
          throw new HttpError(409, 'identity-mismatch', POLICY_MESSAGES['identity-mismatch'])
        }
        if (
          entry.meta.sessionCreatedAt !== null &&
          Number.isSafeInteger(payloadHeader.createdAt) &&
          payloadHeader.createdAt !== entry.meta.sessionCreatedAt
        ) {
          throw new HttpError(409, 'identity-mismatch', '回收站正文的 createdAt 与删除时记录不一致，拒绝还原')
        }
        if (
          entry.meta.sessionCwd &&
          typeof payloadHeader.cwd === 'string' &&
          payloadHeader.cwd &&
          compareKey(payloadHeader.cwd) !== compareKey(entry.meta.sessionCwd)
        ) {
          throw new HttpError(409, 'identity-mismatch', '回收站正文的 cwd 与删除时记录不一致，拒绝还原')
        }
      } else if (POLICY.requireVerifiedSession) {
        throw new HttpError(409, 'identity-unknown', '无法从回收站正文确认会话身份，拒绝还原')
      }
      const rootInfo = resolveSessionsRootInfo()
      const resolved = resolveRestoreTarget(entry.meta, rootInfo, { relocate })
      relocated = resolved.relocated
      if (relocated) warnings.push(`会话根已变更，已按选择迁移到当前根：${resolved.currentRoot}`)
      // Write the intent before the rename: a crash after the rename must be
      // recoverable from meta.json alone.
      patchMeta(entry, {
        phase: 'restoring-payload',
        complete: true,
        restoreTarget: resolved.target,
        restoreRoot: rootInfo.root,
        attachPending: true,
      })
      try {
        fs.renameSync(payloadOf(entry), resolved.target)
        syncDirectoryBestEffort(path.dirname(resolved.target))
        syncDirectoryBestEffort(entry.dir)
      } catch (error) {
        try {
          patchMeta(entry, {
            phase: 'projections-moved',
            complete: true,
            restoreTarget: '',
            attachPending: false,
          })
        } catch {
          /* keep the intent marker for recovery */
        }
        if (error?.code === 'EXDEV') {
          throw new HttpError(409, 'cross-device', POLICY_MESSAGES['cross-device'])
        }
        throw new HttpError(500, 'restore-failed', `还原正文失败：${safeString(error?.message ?? error)}`)
      }
      try {
        patchMeta(entry, { phase: 'restored-payload', complete: true, restoredAt: nowIso(), attachPending: true })
      } catch (error) {
        warnings.push(`保存还原状态失败，启动时将按 restoreTarget 恢复：${safeString(error?.message ?? error, 300)}`)
      }
    } else if (entry.meta.phase === 'restoring-payload' && inspection.restoredTarget) {
      // Crash after the payload rename but before the phase was updated.
      patchMeta(entry, {
        phase: 'restored-payload',
        complete: true,
        restoredAt: nowIso(),
        attachPending: true,
      })
    }

    const projection = restoreProjectionFiles(entry.meta, entry.dir)
    warnings.push(...projection.warnings)
    let refs
    try {
      refs = await attachRefs(entry.meta.sessionId, entry.meta)
    } catch (error) {
      refs = {
        changed: false,
        warnings: [`恢复侧边栏引用失败：${safeString(error?.message ?? error, 500)}`],
        reason: 'attach-failed',
      }
    }
    warnings.push(...(refs.warnings ?? []))
    let refsPendingRetained = false
    if ((refs.warnings ?? []).length) {
      try {
        appendRepair({
          kind: 'attach',
          sessionId: entry.meta.sessionId,
          workspaceId: entry.meta.workspaceId,
          workspacePath: entry.meta.workspacePath,
          wasListed: entry.meta.wasListed,
          wasArchived: entry.meta.wasArchived,
          wasPinned: entry.meta.wasPinned,
          requestedAt: nowIso(),
          operationId: entry.entryId,
          code: refs.reason ?? 'attach-warning',
        })
      } catch (error) {
        refsPendingRetained = true
        warnings.push(`修复队列写入失败，条目保留以便启动重试：${safeString(error?.message ?? error, 300)}`)
      }
    } else {
      try {
        patchMeta(entry, { attachPending: false })
      } catch {
        /* startup will retry the attach; attachSession is idempotent */
      }
    }

    const partial = projection.partial === true || refsPendingRetained
    if (partial) {
      try {
        patchMeta(entry, {
          phase: 'restored-payload',
          complete: true,
          restoredAt: entry.meta.restoredAt || nowIso(),
          projectionFiles: [...new Set([...projection.restored, ...projection.missing, ...projection.conflicts, ...projection.remaining])],
          recovery: 'partial-projection',
        })
        warnings.push('部分投影缓存未能还原；回收站条目已保留，可重试或明确清理残留')
      } catch (error) {
        warnings.push(`保存部分还原状态失败：${safeString(error?.message ?? error, 300)}`)
      }
    } else {
      try {
        removeTrashDir(entryId)
      } catch (error) {
        warnings.push(`回收站条目清理失败：${safeString(error?.message ?? error, 300)}`)
      }
    }
    log({
      action: 'restore',
      sessionId: entry.meta.sessionId,
      entryId,
      refs: refs.changed === true,
      relsPending: false,
      relocated,
      partial,
      warnings,
    })
    return {
      sessionId: entry.meta.sessionId,
      refs: refs.changed === true,
      refsReason: refs.reason ?? null,
      warnings,
      partial,
      retained: partial,
      relocated,
      committed: true,
    }
  }

  function purge(entryId, typedConfirm, { force = false } = {}) {
    const entry = readTrashEntry(entryId)
    if (!entry.valid) throw new HttpError(403, 'orphan', POLICY_MESSAGES.orphan)
    const inspection = inspectTrashEntry(entry)
    assertPolicy(entry.meta.sessionId, { forPurge: true, meta: entry.meta })
    const code = trashPolicyRejection(entry.meta, { auto: false })
    if (code && !(force && ['broken', 'incomplete', 'refs-pending'].includes(code))) throwPolicy(code)
    if ((inspection.broken || inspection.incomplete) && !force) {
      throwPolicy(inspection.broken ? 'broken' : 'incomplete')
    }
    if (inspection.refsPending && !force) throwPolicy('refs-pending')
    if (force || inspection.broken || inspection.incomplete) {
      // Explicit disposal of a damaged/incomplete entry is a separate, always
      // typed action. It still stays inside TRASH_DIR and never touches payload
      // outside it.
      if (String(typedConfirm ?? '') !== POLICY.purgeConfirmWord) {
        throw new HttpError(400, 'confirm-word', `彻底删除损坏条目：需要输入确认词 ${POLICY.purgeConfirmWord}`)
      }
    } else {
      assertTypedConfirm(typedConfirm, 1, '彻底删除')
    }
    if (POLICY.auditRequiredForPurge) {
      if (!log({ action: 'purge-intent', entryId, sessionId: entry.meta.sessionId, force })) {
        throw new HttpError(503, 'audit-required', POLICY_MESSAGES['audit-required'])
      }
    }
    removeTrashEntry(entry)
    const audit = log({ action: 'purge', entryId, sessionId: entry.meta.sessionId, force })
    return { entryId, audit, forced: force }
  }

  function purgeOrphan(entryId, typedConfirm) {
    if (typeof entryId !== 'string' || !TRASH_ENTRY_ID_RE.test(entryId)) {
      throw new HttpError(400, 'bad-entry', '回收站条目 id 不合法')
    }
    if (String(typedConfirm ?? '') !== POLICY.purgeConfirmWord) {
      throw new HttpError(400, 'confirm-word', `清理异常条目：需要输入确认词 ${POLICY.purgeConfirmWord}`)
    }
    assertEnabled()
    if (!POLICY.allowPurge) throwPolicy('purge-disabled')
    const entry = readTrashEntry(entryId)
    if (entry.valid) {
      throw new HttpError(409, 'not-orphan', '这个条目有有效 meta.json，请使用普通彻底删除')
    }
    if (POLICY.auditRequiredForPurge && !log({ action: 'purge-orphan-intent', entryId })) {
      throw new HttpError(503, 'audit-required', POLICY_MESSAGES['audit-required'])
    }
    removeTrashDir(entryId)
    const audit = log({ action: 'purge-orphan', entryId, reason: entry.reason })
    return { entryId, audit }
  }

  function purgeAll(entryIds, typedConfirm, confirmCount) {
    assertEnabled()
    if (!POLICY.allowPurge) throwPolicy('purge-disabled')
    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      throw new HttpError(400, 'snapshot-required', '清空回收站需要提供预览时的条目 id 集合（entryIds）')
    }
    const requested = entryIds.map(String)
    if (new Set(requested).size !== requested.length) throw new HttpError(400, 'duplicate', '清空回收站：条目 id 重复')
    if (confirmCount !== undefined && confirmCount !== null && Number(confirmCount) !== requested.length) {
      throw new HttpError(400, 'confirm-mismatch', `清空回收站：确认数量不一致（收到 ${confirmCount}，列表 ${requested.length}）`)
    }
    const listed = validTrashEntries()
    const current = new Set(listed.map((entry) => entry.entryId))
    if (requested.length !== current.size || requested.some((id) => !current.has(id))) {
      throw new HttpError(
        409,
        'stale',
        `回收站内容已变化（界面确认 ${requested.length} 条，实际 ${listed.length} 条），请刷新后重新确认`,
        { requested, current: [...current] },
      )
    }
    if (String(typedConfirm ?? '') !== POLICY.purgeConfirmWord) {
      throw new HttpError(400, 'confirm-word', `清空回收站：需要输入确认词 ${POLICY.purgeConfirmWord}`)
    }
    if (POLICY.auditRequiredForPurge && !log({ action: 'purge-all-intent', entryIds: requested })) {
      throw new HttpError(503, 'audit-required', POLICY_MESSAGES['audit-required'])
    }
    const skipped = []
    let count = 0
    for (const entry of listed) {
      const inspection = inspectTrashEntry(entry)
      const code = trashPolicyRejection(entry.meta, { auto: false })
      if (code) {
        skipped.push({ entryId: entry.entryId, sessionId: entry.meta.sessionId, code })
        continue
      }
      if (inspection.broken || inspection.incomplete) {
        skipped.push({
          entryId: entry.entryId,
          sessionId: entry.meta.sessionId,
          code: inspection.broken ? 'broken' : 'incomplete',
        })
        continue
      }
      if (inspection.refsPending) {
        skipped.push({ entryId: entry.entryId, sessionId: entry.meta.sessionId, code: 'refs-pending' })
        continue
      }
      try {
        removeTrashEntry(entry)
        count += 1
      } catch (error) {
        skipped.push({
          entryId: entry.entryId,
          sessionId: entry.meta.sessionId,
          code: 'error',
          error: safeString(error?.message ?? error, 500),
        })
      }
    }
    log({ action: 'purge-all', count, skipped: skipped.length, skippedCodes: skipped.map((item) => item.code) })
    return { count, skipped }
  }

  // ── 删除/还原批量 ──────────────────────────────────────────────
  async function batchTrash(ids, confirmCount) {
    assertEnabled()
    const list = assertBatch(ids, confirmCount, '批量删除', { requireCount: true })
    const scanHint = scanSessionDirs()
    const results = []
    for (const id of list) {
      try {
        const result = await moveToTrash(id, { reason: 'batch', scanHint })
        results.push({
          id,
          ok: true,
          entryId: result.entryId,
          bytes: result.bytes,
          warnings: result.warnings,
          refsPending: result.refsPending === true,
        })
      } catch (error) {
        results.push({
          id,
          ok: false,
          code: error instanceof HttpError ? error.code : 'error',
          error: safeString(error?.message ?? error),
          details: error instanceof HttpError ? error.details : undefined,
        })
      }
    }
    const succeeded = results.filter((result) => result.ok).length
    log({
      action: 'trash-batch',
      requested: list.length,
      succeeded,
      failed: list.length - succeeded,
      results: results.map((row) => ({ id: row.id, ok: row.ok, code: row.code })).slice(0, 100),
    })
    return { results, succeeded, failed: list.length - succeeded }
  }

  async function batchRestore(entryIds) {
    assertEnabled()
    const list = assertBatch(entryIds, undefined, '批量还原')
    const results = []
    for (const entryId of list) {
      try {
        const result = await restore(entryId)
        results.push({
          entryId,
          ok: true,
          sessionId: result.sessionId,
          warnings: result.warnings,
          partial: result.partial === true,
          retained: result.retained === true,
        })
      } catch (error) {
        results.push({
          entryId,
          ok: false,
          code: error instanceof HttpError ? error.code : 'error',
          error: safeString(error?.message ?? error),
          details: error instanceof HttpError ? error.details : undefined,
        })
      }
    }
    const succeeded = results.filter((result) => result.ok).length
    const partial = results.filter((result) => result.ok && result.partial).length
    log({
      action: 'restore-batch',
      requested: list.length,
      succeeded,
      partial,
      failed: list.length - succeeded,
      results: results.map((row) => ({ entryId: row.entryId, ok: row.ok, code: row.code })).slice(0, 100),
    })
    return { results, succeeded, failed: list.length - succeeded, partial }
  }

  async function batchPurge(entryIds, confirmCount, typedConfirm) {
    assertEnabled()
    if (!POLICY.allowPurge) throwPolicy('purge-disabled')
    const list = assertBatch(entryIds, confirmCount, '批量彻底删除', { requireCount: true })
    assertTypedConfirm(typedConfirm, list.length, '批量彻底删除')
    const results = []
    for (const entryId of list) {
      try {
        const result = purge(entryId, typedConfirm)
        results.push({ entryId, ok: true, audit: result.audit })
      } catch (error) {
        results.push({
          entryId,
          ok: false,
          code: error instanceof HttpError ? error.code : 'error',
          error: safeString(error?.message ?? error),
          details: error instanceof HttpError ? error.details : undefined,
        })
      }
    }
    const succeeded = results.filter((result) => result.ok).length
    log({
      action: 'purge-batch',
      requested: list.length,
      succeeded,
      failed: list.length - succeeded,
      results: results.map((row) => ({ entryId: row.entryId, ok: row.ok, code: row.code })).slice(0, 100),
    })
    return { results, succeeded, failed: list.length - succeeded }
  }

  // ── 排队 ──────────────────────────────────────────────────────
  function readStore(file, label, normalize, maxItems) {
    const linkStat = lstatOrNull(file)
    if (!linkStat) return { items: [], ok: true, missing: true, corrupt: false, invalid: 0, truncated: false }
    if (linkStat.isSymbolicLink()) {
      return { items: [], ok: false, corrupt: true, symlink: true, error: `${label} 是符号链接`, invalid: 0, truncated: false }
    }
    let stat
    try {
      stat = fs.statSync(file)
    } catch (error) {
      return { items: [], ok: false, corrupt: true, error: safeString(error?.message ?? error), invalid: 0, truncated: false }
    }
    try {
      if (stat.size > MAX_JSON_READ_BYTES) {
        return { items: [], ok: false, corrupt: true, error: `${label} 超过读取上限`, invalid: 0, truncated: false }
      }
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(doc)) {
        return { items: [], ok: false, corrupt: true, error: `${label} 不是数组`, invalid: 0, truncated: false }
      }
      const items = []
      let invalid = 0
      let truncated = false
      for (const raw of doc) {
        if (items.length >= maxItems) {
          truncated = true
          break
        }
        const item = normalize(raw)
        if (!item) {
          invalid += 1
          continue
        }
        items.push(item)
      }
      return { items, ok: true, missing: false, corrupt: false, invalid, truncated, total: doc.length }
    } catch (error) {
      return { items: [], ok: false, corrupt: true, error: safeString(error?.message ?? error), invalid: 0, truncated: false }
    }
  }

  function quarantineStore(file, label) {
    try {
      assertNoSymlinkAncestors(file, DATA_DIR)
      const stat = lstatOrNull(file)
      if (!stat) return null
      if (stat.isSymbolicLink()) throw new Error('refusing to quarantine a symlink')
      const target = `${file}.corrupt-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17)}-${crypto.randomBytes(3).toString('hex')}`
      fs.renameSync(file, target)
      log({ action: 'store-quarantined', store: label, target: path.basename(target) })
      return target
    } catch (error) {
      log({ action: 'store-quarantine-failed', store: label, error: safeString(error?.message ?? error, 300) })
      return null
    }
  }

  function normalizePendingItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId : ''
    if (!ANY_SESSION_ID_RE.test(sessionId)) return null
    const createdAt =
      typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt > 0
        ? item.createdAt
        : null
    return {
      sessionId,
      requestedAt: typeof item.requestedAt === 'string' ? item.requestedAt : nowIso(),
      title: safeString(typeof item.title === 'string' ? item.title : '', 300),
      workspacePath: typeof item.workspacePath === 'string' ? item.workspacePath : '',
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      createdAt,
      kind: item.kind === 'main' || item.kind === 'subagent' || item.kind === 'unknown' ? item.kind : undefined,
      reason: typeof item.reason === 'string' ? item.reason : 'queued-while-live',
    }
  }

  function readPendingStore() {
    return readStore(PENDING_FILE, 'pending.json', normalizePendingItem, MAX_PENDING_ITEMS)
  }
  function readPending() {
    return readPendingStore().items
  }
  function writePending(list) {
    if (!Array.isArray(list)) throw new HttpError(500, 'bad-store', '排队表必须是数组')
    if (list.length > POLICY.maxPending) {
      throw new HttpError(413, 'pending-full', `排队表已达上限 ${POLICY.maxPending} 条，拒绝截断已有待办`)
    }
    try {
      assertNoSymlinkAncestors(PENDING_FILE, DATA_DIR)
      const stat = lstatOrNull(PENDING_FILE)
      if (stat?.isSymbolicLink()) throw new HttpError(409, 'unsafe-root', 'pending.json 是符号链接，拒绝写入')
      writeJsonAtomic(PENDING_FILE, list)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(500, 'pending-write-failed', `写入排队表失败：${safeString(error?.message ?? error)}`)
    }
  }

  function normalizeRepairItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    if (typeof item.sessionId !== 'string' || !ANY_SESSION_ID_RE.test(item.sessionId)) return null
    if (item.kind !== 'attach') return null
    return {
      kind: 'attach',
      sessionId: item.sessionId,
      workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : '',
      workspacePath: typeof item.workspacePath === 'string' ? item.workspacePath : '',
      wasListed: item.wasListed !== false,
      wasArchived: item.wasArchived === true,
      wasPinned: item.wasPinned === true,
      requestedAt: typeof item.requestedAt === 'string' ? item.requestedAt : nowIso(),
      operationId: typeof item.operationId === 'string' ? safeString(item.operationId, 220) : '',
      code: typeof item.code === 'string' ? safeString(item.code, 80) : '',
    }
  }
  function readRepairsStore() {
    return readStore(REPAIR_FILE, 'repair.json', normalizeRepairItem, MAX_REPAIR_ITEMS)
  }
  function readRepairs() {
    return readRepairsStore().items
  }
  function writeRepairs(list) {
    if (!Array.isArray(list)) throw new HttpError(500, 'bad-store', '修复队列必须是数组')
    if (list.length > POLICY.maxPending) {
      throw new HttpError(413, 'repair-full', `修复队列已达上限 ${POLICY.maxPending} 条，拒绝截断`)
    }
    try {
      assertNoSymlinkAncestors(REPAIR_FILE, DATA_DIR)
      const stat = lstatOrNull(REPAIR_FILE)
      if (stat?.isSymbolicLink()) throw new HttpError(409, 'unsafe-root', 'repair.json 是符号链接，拒绝写入')
      writeJsonAtomic(REPAIR_FILE, list)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(500, 'repair-write-failed', `写入修复队列失败：${safeString(error?.message ?? error)}`)
    }
  }
  function repairKey(item) {
    return `${item.kind}:${item.sessionId}:${item.operationId || item.requestedAt || ''}`
  }
  function appendRepair(item) {
    const store = readRepairsStore()
    if (store.corrupt && store.symlink) throw new HttpError(409, 'unsafe-root', 'repair.json 是符号链接')
    if (store.corrupt) {
      const quarantined = quarantineStore(REPAIR_FILE, 'repair.json')
      if (!quarantined) throw new HttpError(409, 'repair-corrupt', '修复队列损坏且无法隔离，拒绝覆盖')
    }
    const list = store.corrupt ? [] : store.items
    if (list.length >= POLICY.maxPending) throw new HttpError(413, 'repair-full', POLICY_MESSAGES['repair-full'])
    const key = repairKey(item)
    if (!list.some((entry) => repairKey(entry) === key)) list.push(item)
    writeRepairs(list)
  }

  function assertQueueable(id, snapshot, kind) {
    assertEnabled()
    assertProtectionKnown(snapshot)
    const code = policyBlockForId(
      id,
      { pinned: snapshot.pinned.has(id), archived: snapshot.archived.has(id), kind },
      { kind, protection: snapshot.protection },
    )
    if (code) throwPolicy(code)
  }

  async function queue(id) {
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) throw new HttpError(400, 'bad-id', '会话 id 不合法')
    const snapshot = workspaceSnapshot()
    let found = findSessionDir(id)
    assertNoSymlinkAncestors(found.dir, found.scan.root)
    const stored = await readStoredHeaders()
    const identity = resolveSessionIdentity(id, found, stored)
    if (identity.header && identity.header.id !== id) {
      throw new HttpError(409, 'identity-mismatch', POLICY_MESSAGES['identity-mismatch'])
    }
    if (POLICY.requireVerifiedSession && !identity.verified) {
      throw new HttpError(409, 'identity-unknown', POLICY_MESSAGES['identity-unknown'])
    }
    const kind = classifySession(id, identity.header)
    assertQueueable(id, snapshot, kind)

    let store = readPendingStore()
    let quarantined = null
    if (store.corrupt) {
      if (store.symlink) throw new HttpError(409, 'unsafe-root', 'pending.json 是符号链接，拒绝覆盖')
      quarantined = quarantineStore(PENDING_FILE, 'pending.json')
      if (!quarantined) throw new HttpError(409, 'pending-corrupt', '排队文件损坏且无法隔离，拒绝覆盖')
      store = { items: [], ok: true, missing: false, corrupt: false, invalid: 0, truncated: false }
    }
    if (store.truncated) throw new HttpError(409, 'pending-corrupt', '排队文件超过可处理条数，未覆盖；请先隔离或人工处理')
    const list = store.items
    if (list.some((item) => item.sessionId === id)) return { sessionId: id, quarantined }
    if (list.length >= POLICY.maxPending) throw new HttpError(413, 'pending-full', `排队表已达上限 ${POLICY.maxPending} 条`)
    const meta = projectTitle(id)
    list.push({
      sessionId: id,
      requestedAt: nowIso(),
      title: meta.title,
      workspacePath: typeof identity.header?.cwd === 'string' && identity.header.cwd ? identity.header.cwd : meta.cwd,
      cwd: typeof identity.header?.cwd === 'string' ? identity.header.cwd : meta.cwd,
      createdAt:
        Number.isSafeInteger(identity.header?.createdAt) && identity.header.createdAt > 0
          ? identity.header.createdAt
          : null,
      kind,
      reason: 'queued-while-live',
    })
    writePending(list)
    log({ action: 'queue', sessionId: id, quarantined: Boolean(quarantined) })
    return { sessionId: id, quarantined }
  }
  function unqueue(id) {
    assertEnabled()
    if (typeof id !== 'string' || !ANY_SESSION_ID_RE.test(id)) throw new HttpError(400, 'bad-id', '会话 id 不合法')
    const store = readPendingStore()
    if (store.corrupt) throw new HttpError(409, 'pending-corrupt', POLICY_MESSAGES['pending-corrupt'])
    writePending(store.items.filter((item) => item.sessionId !== id))
    log({ action: 'unqueue', sessionId: id })
    return { sessionId: id }
  }

  function permanentPendingCode(code) {
    return [
      'config-invalid',
      'disabled',
      'purge-disabled',
      'protected',
      'subagent-protected',
      'kind-unknown',
      'pinned-protected',
      'archived-protected',
      'bad-id',
      'ambiguous',
      'identity-changed',
      'identity-mismatch',
    ].includes(code)
  }

  function pendingResult(result, code) {
    if (code === 'live' || code === 'live-unknown') return 'still-live'
    if (code === 'activity-unknown' || code === 'active') return 'activity-unknown'
    if (code === 'identity-unknown') return 'identity-unknown'
    return result
  }

  async function processPending({ trigger = 'manual', expectedIds = null } = {}) {
    assertEnabled()
    const store = readPendingStore()
    if (store.corrupt) throw new HttpError(409, 'pending-corrupt', POLICY_MESSAGES['pending-corrupt'])
    if (store.truncated) throw new HttpError(409, 'pending-corrupt', '排队文件超过可处理条数，拒绝静默截断')
    const list = store.items
    if (expectedIds !== null) {
      if (!Array.isArray(expectedIds)) throw new HttpError(400, 'snapshot-required', '执行排队删除需要提供确认的会话 id 集合')
      const requested = expectedIds.map(String)
      const current = list.map((item) => item.sessionId)
      if (
        new Set(requested).size !== requested.length ||
        requested.length !== current.length ||
        requested.some((id) => !current.includes(id))
      ) {
        throw new HttpError(409, 'stale', '排队表已变化，请刷新后重新确认', { requested, current })
      }
    }
    if (!list.length) {
      startupReport = []
      return { results: [], succeeded: 0, failed: 0, remaining: 0, trigger }
    }
    const stored = await readStoredHeaders()
    const warnings = [...stored.warnings]
    const results = []
    const keep = []
    for (const item of list) {
      const id = item.sessionId
      try {
        const found = findSessionDir(id)
        const identity = resolveSessionIdentity(id, found, stored)
        const header = identity.header
        const identityRecorded = item.createdAt !== null || Boolean(item.cwd)
        if (!header) {
          // A queued identity can never be silently skipped just because the
          // index read failed or the header disappeared.
          keep.push(item)
          results.push({
            sessionId: id,
            result: 'identity-unknown',
            code: 'identity-unknown',
            reason: identityRecorded ? 'recorded-identity-unreadable' : 'no-recorded-identity',
          })
          continue
        }
        if (item.createdAt === null && !item.cwd) {
          keep.push(item)
          results.push({ sessionId: id, result: 'identity-unknown', code: 'identity-unknown', reason: 'no-recorded-identity' })
          continue
        }
        if (header.id !== id) {
          results.push({ sessionId: id, result: 'dropped', code: 'identity-mismatch' })
          continue
        }
        if (item.createdAt !== null) {
          if (!Number.isFinite(header.createdAt)) {
            keep.push(item)
            results.push({ sessionId: id, result: 'identity-unknown', code: 'identity-unknown' })
            continue
          }
          if (header.createdAt !== item.createdAt) {
            results.push({ sessionId: id, result: 'dropped', code: 'identity-changed' })
            continue
          }
        }
        if (item.cwd) {
          if (typeof header.cwd !== 'string' || !header.cwd) {
            keep.push(item)
            results.push({ sessionId: id, result: 'identity-unknown', code: 'identity-unknown' })
            continue
          }
          if (compareKey(item.cwd) !== compareKey(header.cwd)) {
            results.push({ sessionId: id, result: 'dropped', code: 'identity-changed' })
            continue
          }
        }
        if (item.kind && item.kind !== classifySession(id, header)) {
          results.push({ sessionId: id, result: 'dropped', code: 'identity-changed' })
          continue
        }
        const result = await moveToTrash(id, {
          reason: trigger === 'startup' ? 'pending-at-startup' : 'pending-manual',
          requestId: `pending:${id}:${item.requestedAt}`,
        })
        results.push({
          sessionId: id,
          result: 'trashed',
          entryId: result.entryId,
          warnings: result.warnings,
          idempotent: result.idempotent === true,
        })
      } catch (error) {
        const code = error instanceof HttpError ? error.code : 'error'
        if (code === 'not-found') {
          results.push({ sessionId: id, result: 'already-gone' })
        } else if (code === 'identity-unknown') {
          keep.push(item)
          results.push({ sessionId: id, result: 'identity-unknown', code })
        } else if (permanentPendingCode(code)) {
          results.push({ sessionId: id, result: 'dropped', code, error: safeString(error?.message ?? error) })
        } else {
          keep.push(item)
          results.push({
            sessionId: id,
            result: pendingResult('failed', code),
            code,
            error: safeString(error?.message ?? error),
            details: error instanceof HttpError ? error.details : undefined,
          })
        }
      }
    }
    let persistFailed = false
    try {
      writePending(keep)
    } catch (error) {
      persistFailed = true
      warnings.push(`保存剩余排队项失败：${safeString(error?.message ?? error, 300)}`)
    }
    startupReport = results
    log({
      action: 'process-pending',
      trigger,
      results: results.map((row) => ({ sessionId: row.sessionId, result: row.result, code: row.code })).slice(0, 100),
      persistFailed,
    })
    return {
      results,
      succeeded: results.filter((item) => item.result === 'trashed').length,
      failed: results.filter((item) => item.result === 'failed' || item.result === 'dropped').length,
      remaining: keep.length,
      warnings,
      persistFailed,
      trigger,
    }
  }

  async function retryPendingRefs() {
    const registry = getWorkspaceRegistry()
    if (!registry) return { retried: 0, cleared: 0, warnings: ['workspaceRegistry 不可用'] }
    let retried = 0
    let cleared = 0
    const warnings = []
    for (const entry of validTrashEntries()) {
      if (!entry.meta.refsPending) continue
      retried += 1
      try {
        const result = await detachRefs(entry.meta.sessionId, {
          wasListed: entry.meta.wasListed,
          workspaceId: entry.meta.workspaceId,
          wasArchived: entry.meta.wasArchived,
          wasPinned: entry.meta.wasPinned,
          snapshot: { registry, raw: readIndex() },
        })
        if (result.pending || (result.warnings ?? []).length) {
          warnings.push(...(result.warnings ?? []))
          patchMeta(entry, { refsPending: true, phase: 'refs-pending' })
          continue
        }
        patchMeta(entry, {
          refsPending: false,
          refsDetached: true,
          phase: entry.meta.complete === false ? 'projections-moved' : 'complete',
          complete: true,
        })
        cleared += 1
      } catch (error) {
        warnings.push(`引用修复失败：${safeString(error?.message ?? error, 300)}`)
      }
    }
    if (retried) log({ action: 'retry-refs', retried, cleared, warnings })
    return { retried, cleared, warnings }
  }

  async function retryRepairs() {
    const store = readRepairsStore()
    if (store.corrupt) {
      return { retried: 0, cleared: 0, warnings: [store.error ?? 'repair.json 不可读'] }
    }
    const list = store.items
    if (!list.length) return { retried: 0, cleared: 0 }
    const registry = getWorkspaceRegistry()
    if (!registry) return { retried: 0, cleared: 0, warnings: ['workspaceRegistry 不可用'] }
    const keep = []
    let cleared = 0
    for (const item of list) {
      try {
        const result = await attachRefs(item.sessionId, item)
        if (result.warnings?.length) keep.push(item)
        else cleared += 1
      } catch {
        keep.push(item)
      }
    }
    try {
      writeRepairs(keep)
    } catch (error) {
      return { retried: list.length, cleared, warnings: [`保存修复队列失败：${safeString(error?.message ?? error, 300)}`] }
    }
    if (cleared) log({ action: 'retry-repairs', retried: list.length, cleared })
    return { retried: list.length, cleared }
  }

  // ── 回收站启动恢复 ─────────────────────────────────────────────
  let recoveryReport = []
  function recoverTrash() {
    const actions = []
    recoveryReport = actions
    if (POLICY.configErrors.length) {
      actions.push({ result: 'skipped', code: 'config-invalid' })
      return actions
    }
    if (!POLICY.enabled) {
      actions.push({ result: 'skipped', code: 'disabled' })
      return actions
    }
    for (const entry of scanTrashEntries()) {
      if (!entry.valid) {
        actions.push({ entryId: entry.entryId, result: 'orphan', reason: entry.reason })
        continue
      }
      const inspection = inspectTrashEntry(entry)
      const projectionNames = [...new Set([...entry.meta.projectionExpected, ...inspection.projectionFiles])]
      try {
        if (entry.meta.phase === 'restoring-payload') {
          if (inspection.restoredTarget) {
            patchMeta(entry, {
              phase: 'restored-payload',
              complete: true,
              restoredAt: entry.meta.restoredAt || nowIso(),
              attachPending: true,
              recovery: 'restore-completed-after-crash',
            })
            actions.push({ entryId: entry.entryId, result: 'restore-completed', attachPending: true })
            continue
          }
          if (inspection.payloadExists) {
            // The rename never happened; the payload is still safely in trash.
            patchMeta(entry, { phase: 'projections-moved', complete: true, restoreTarget: '', attachPending: false })
            actions.push({ entryId: entry.entryId, result: 'restore-not-started' })
            continue
          }
        }
        if (inspection.payloadExists) {
          if (entry.meta.phase === 'restored-payload') {
            patchMeta(entry, { broken: true, recovery: 'payload-present-after-restore' })
            actions.push({ entryId: entry.entryId, result: 'broken', reason: 'payload-present-after-restore' })
            continue
          }
          if (
            entry.meta.complete === false ||
            ['prepared', 'payload-moved', 'projections-moved', 'refs-pending'].includes(entry.meta.phase)
          ) {
            // Payload is committed. Reconcile the projection list from disk and
            // force a refs retry; never declare success based only on a flag.
            patchMeta(entry, {
              phase: 'refs-pending',
              complete: true,
              refsPending: true,
              projectionFiles: projectionNames.slice(0, MAX_PROJECTION_FILES),
              recovery: 'recovered-payload',
            })
            actions.push({
              entryId: entry.entryId,
              result: 'completed-payload',
              refsPending: true,
              projectionFiles: projectionNames.length,
            })
            continue
          }
          if (entry.meta.refsPending) {
            actions.push({ entryId: entry.entryId, result: 'refs-pending' })
          }
          continue
        }

        if (entry.meta.phase === 'restored-payload') {
          if (entry.meta.attachPending) {
            actions.push({ entryId: entry.entryId, result: 'attach-pending' })
          } else if (inspection.projectionFiles.length === 0) {
            // Everything was restored; retain the empty shell for an explicit
            // user purge instead of deleting it during a read-only startup.
            patchMeta(entry, { phase: 'empty', complete: false, broken: true, recovery: 'restored-empty' })
            actions.push({ entryId: entry.entryId, result: 'retained-empty', reason: 'restored-empty' })
          } else {
            actions.push({
              entryId: entry.entryId,
              result: 'partial-restore',
              projectionFiles: inspection.projectionFiles.length,
            })
          }
          continue
        }

        if (entry.meta.phase !== 'prepared' && inspection.restoredTarget) {
          // A crash after the payload rename (or a restore whose phase write
          // was lost) leaves the session at its target. Treat that as restored
          // and let the startup attach retry finish the job.
          patchMeta(entry, {
            phase: 'restored-payload',
            complete: true,
            restoredAt: nowIso(),
            restoreTarget: inspection.restoredTarget,
            attachPending: true,
            recovery: 'payload-at-target',
          })
          actions.push({ entryId: entry.entryId, result: 'restore-completed', attachPending: true })
          continue
        }

        if (inspection.projectionFiles.length > 0) {
          patchMeta(entry, {
            phase: 'aborted',
            complete: false,
            refsPending: false,
            broken: true,
            projectionFiles: inspection.projectionFiles.slice(0, MAX_PROJECTION_FILES),
            recovery: 'payload-missing-projection-conflict',
          })
          actions.push({ entryId: entry.entryId, result: 'broken', reason: 'payload-missing-projection-conflict' })
          continue
        }

        // No payload, no projection. Do not rmSync it: a read-only policy must
        // not delete data during startup, even if it looks empty.
        patchMeta(entry, {
          phase: 'empty',
          complete: false,
          refsPending: false,
          broken: true,
          recovery: 'empty-uncommitted',
        })
        actions.push({ entryId: entry.entryId, result: 'retained-empty', reason: 'empty-uncommitted' })
      } catch (error) {
        actions.push({
          entryId: entry.entryId,
          result: 'recovery-failed',
          error: safeString(error?.message ?? error, 300),
        })
      }
    }
    const changed = actions.filter((item) => item.result !== 'skipped' && item.result !== 'orphan')
    if (changed.length) log({ action: 'trash-recovery', actions: changed.slice(0, 100) })
    return actions
  }

  async function retryPendingAttaches() {
    let retried = 0
    let cleared = 0
    const warnings = []
    for (const entry of validTrashEntries()) {
      if (entry.meta.phase !== 'restored-payload' || !entry.meta.attachPending) continue
      retried += 1
      try {
        const refs = await attachRefs(entry.meta.sessionId, entry.meta)
        warnings.push(...(refs.warnings ?? []))
        if ((refs.warnings ?? []).length) continue
        patchMeta(entry, { attachPending: false })
        cleared += 1
        if (inspectTrashEntry(entry).projectionFiles.length === 0) {
          try {
            removeTrashDir(entry.entryId)
          } catch (error) {
            warnings.push(`清理已还原条目失败：${safeString(error?.message ?? error, 300)}`)
          }
        }
      } catch (error) {
        warnings.push(`恢复侧边栏引用失败：${safeString(error?.message ?? error, 300)}`)
      }
    }
    if (retried) log({ action: 'retry-attach', retried, cleared, warnings })
    return { retried, cleared, warnings }
  }

  // ── 自动清理 ──────────────────────────────────────────────────
  let lastSweep = null
  function sweepTrash() {
    if (POLICY.configErrors.length) {
      lastSweep = { removed: 0, skipped: 0, reason: 'config-invalid' }
      return lastSweep
    }
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
      const inspection = inspectTrashEntry(entry)
      if (inspection.incomplete || inspection.broken || inspection.refsPending) {
        skipped.push({
          entryId: entry.entryId,
          sessionId: entry.meta.sessionId,
          code: inspection.incomplete ? 'incomplete' : inspection.broken ? 'broken' : 'refs-pending',
        })
        continue
      }
      const code = trashPolicyRejection(entry.meta, { auto: true })
      if (code) {
        skipped.push({ entryId: entry.entryId, sessionId: entry.meta.sessionId, code })
        continue
      }
      if (POLICY.auditRequiredForPurge && !log({ action: 'sweep-intent', entryId: entry.entryId, sessionId: entry.meta.sessionId })) {
        skipped.push({ entryId: entry.entryId, sessionId: entry.meta.sessionId, code: 'audit-required' })
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
    lastSweep = {
      removed,
      skipped: skipped.length,
      skippedCodes: skipped.map((item) => item.code),
      skippedDetails: skipped.slice(0, 50),
      at: nowIso(),
    }
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

  const isLoopbackAddress = (address) => {
    const value = String(address || '').toLowerCase()
    if (!value) return false
    if (value === '::1') return true
    if (value === '::ffff:127.0.0.1') return true
    if (value.startsWith('127.')) return true
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value)
    if (!mapped) return false
    const high = Number.parseInt(mapped[1], 16)
    const low = Number.parseInt(mapped[2], 16)
    return high === 0x7f00 && low <= 0xffff
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

  function denyRequest(req, res, status, reason) {
    log({
      action: 'fence-denied',
      reason,
      remote: isLoopbackAddress(req?.socket?.remoteAddress) ? 'loopback' : 'non-loopback',
      host: safeString(req?.headers?.host ?? '', 120),
      path: safeString(String(req?.url ?? '').split('?')[0], 200),
    })
    return deny(res, status)
  }

  let fenceWarned = false
  function rejected(req, res) {
    try {
      const conn = connectionFence()
      if (conn) {
        let code
        try {
          code = conn.requestRejection(req)
        } catch (error) {
          return denyRequest(req, res, 403, `connection-error:${safeString(error?.message ?? error, 120)}`)
        }
        if (code !== undefined && code !== null && code !== false) {
          return denyRequest(req, res, typeof code === 'number' ? code : 403, 'connection-rejected')
        }
        return false
      }
      // Without the host fence, a loopback Host header alone is not an
      // identity: a remote client can spoof it. Require the TCP peer itself to
      // be loopback (or a local reverse proxy that connects over loopback).
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        return denyRequest(req, res, 403, 'non-loopback-peer')
      }
      const headers = req.headers ?? {}
      let hostUrl = null
      try {
        hostUrl = new URL(`http://${String(headers.host ?? '')}`)
      } catch {
        return denyRequest(req, res, 403, 'bad-host')
      }
      if (hostUrl.username || hostUrl.password || !isLoopbackHostname(hostUrl.hostname)) {
        return denyRequest(req, res, 403, 'non-loopback-host')
      }
      const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
      if (site === 'cross-site') return denyRequest(req, res, 403, 'cross-site')
      const origin = headers.origin
      if (typeof origin === 'string' && origin) {
        if (origin === 'null') return denyRequest(req, res, 403, 'null-origin')
        let originUrl = null
        try {
          originUrl = new URL(origin)
        } catch {
          return denyRequest(req, res, 403, 'bad-origin')
        }
        if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) {
          return denyRequest(req, res, 403, 'cross-origin')
        }
      }
      if (!fenceWarned) {
        fenceWarned = true
        log({ action: 'fence-fallback', note: '宿主 connection 栅栏不可用，使用插件自带回环/同源校验 + TCP 对端回环检查' })
      }
      return false
    } catch (error) {
      return denyRequest(req, res, 403, `fence-error:${safeString(error?.message ?? error, 120)}`)
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
    const scanned = scanTrashEntries()
    const trash = scanned
      .filter((entry) => entry.valid)
      .map((entry) => {
        const inspection = inspectTrashEntry(entry)
        return {
          entryId: entry.entryId,
          sessionId: entry.meta.sessionId,
          title: entry.meta.title,
          workspacePath: entry.meta.workspacePath,
          bytes: entry.meta.bytes,
          deletedAt: entry.meta.deletedAt,
          reason: entry.meta.reason,
          complete: entry.meta.complete !== false,
          phase: entry.meta.phase,
          broken: inspection.broken,
          incomplete: inspection.incomplete,
          refsPending: inspection.refsPending,
          wasArchived: entry.meta.wasArchived,
          wasPinned: entry.meta.wasPinned,
          projectionFiles: inspection.projectionFiles.length,
          purgeBlockedReason: trashPolicyRejection(entry.meta, { auto: true }),
          forcePurgeAllowed: Boolean(
            POLICY.allowPurge &&
              (inspection.broken ||
                inspection.incomplete ||
                inspection.refsPending ||
                entry.meta.phase === 'restored-payload'),
          ),
        }
      })
    const orphans = scanned
      .filter((entry) => !entry.valid)
      .map((entry) => ({ entryId: entry.entryId, reason: entry.reason }))
    const pendingStore = readPendingStore()
    const pendingLiveness = makeLivenessIndex()
    const pending = pendingStore.items.map((item) => {
      const meta = projectTitle(item.sessionId)
      return {
        ...item,
        title: item.title || meta.title,
        live: livenessFrom(pendingLiveness, item.sessionId) !== 'free',
      }
    })
    const repairStore = readRepairsStore()
    const repairs = repairStore.items
    const rootInfo = resolveSessionsRootInfo()
    const warnings = [...listed.warnings]
    if (POLICY.configErrors.length) warnings.unshift(POLICY_MESSAGES['config-invalid'])
    if (pendingStore.corrupt) warnings.push(`pending.json 不可读：${pendingStore.error ?? 'unknown'}（不会被覆盖）`)
    if (repairStore.corrupt) warnings.push(`repair.json 不可读：${repairStore.error ?? 'unknown'}（不会被覆盖）`)
    sendJson(res, 200, {
      ok: true,
      version: PLUGIN_VERSION,
      dshHome: HOME,
      sessionsRoot: rootInfo.root,
      sessionsRootSource: rootInfo.source,
      dataDir: DATA_DIR,
      logFile: LOG_FILE,
      policy: POLICY,
      configErrors: POLICY.configErrors,
      capabilities: {
        workspaceRegistry: Boolean(getWorkspaceRegistry()),
        sessionPersistence: Boolean(getPersistence()),
        connection: Boolean(connectionFence()),
        activity: typeof ctx.waterfall === 'function' && Boolean(getWorkspaceRegistry()),
        activityKnown: typeof ctx.waterfall === 'function' && Boolean(getWorkspaceRegistry()),
      },
      counts: {
        sessions: listed.sessions.length,
        trash: trash.length,
        pending: pending.length,
        live: listed.sessions.filter((item) => item.liveness === 'live').length,
        subagent: listed.sessions.filter((item) => item.kind === 'subagent').length,
        blocked: listed.sessions.filter((item) => !item.deletable).length,
        repairs: repairs.length,
        refsPending: trash.filter((item) => item.refsPending).length,
        orphans: orphans.length,
      },
      sessions: listed.sessions,
      trash,
      trashIds: trash.map((item) => item.entryId),
      orphans,
      pending,
      pendingIds: pending.map((item) => item.sessionId),
      pendingCorrupt: pendingStore.corrupt,
      startup: startupReport,
      recovery: recoveryReport,
      repairs,
      repairsCorrupt: repairStore.corrupt,
      sweep: lastSweep,
      warnings,
      log: { file: LOG_FILE, bytes: logBytes, rotated: logRotated, writeError: logWriteError, ok: !logWriteError },
      audit: { ok: !logWriteError, writeError: logWriteError },
      live: [...liveIdSet(listed.livenessIndex)],
    })
  })

  register(`${ROUTE_PREFIX}/delete`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(() =>
      moveToTrash(String(body.id ?? ''), { reason: 'manual', requestId: String(body.requestId ?? '') }),
    )
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
    const result = await withMutation(() =>
      restore(String(body.entryId ?? ''), { relocate: body.relocate === true }),
    )
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/purge`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(async () =>
      purge(String(body.entryId ?? ''), body.typedConfirm, { force: body.force === true }),
    )
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/purge-orphan`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(async () =>
      purgeOrphan(String(body.entryId ?? ''), body.typedConfirm),
    )
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/purge-all`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const body = await readJsonBody(req)
    const result = await withMutation(async () =>
      purgeAll(body.entryIds, body.typedConfirm, body.confirmCount),
    )
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
      if (!Array.isArray(body.sessionIds)) {
        throw new HttpError(400, 'snapshot-required', '执行排队删除需要提供预览确认的 sessionIds')
      }
      if (body.confirmCount !== undefined && body.confirmCount !== null) {
        if (Number(body.confirmCount) !== body.sessionIds.length) {
          throw new HttpError(400, 'confirm-mismatch', '执行排队删除的确认数量与列表不一致')
        }
      }
      return processPending({ trigger: 'manual', expectedIds: body.sessionIds })
    })
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/repair-refs`, async (req, res) => {
    if (!wantMethod(req, res, 'POST')) return
    const result = await withMutation(async () => {
      assertEnabled()
      const attaches = await retryPendingAttaches()
      const refs = await retryPendingRefs()
      const repairs = await retryRepairs()
      return { attaches, refs, repairs }
    })
    sendJson(res, 200, { ok: true, ...result })
  })

  register(`${ROUTE_PREFIX}/diagnostics`, async (req, res) => {
    if (!wantMethod(req, res, 'GET')) return
    const listed = await listSessions()
    const scanned = scanTrashEntries()
    const trash = scanned.filter((entry) => entry.valid)
    const orphans = scanned.filter((entry) => !entry.valid)
    const pending = readPendingStore()
    const repairs = readRepairsStore()
    sendJson(res, 200, {
      ok: true,
      generatedAt: nowIso(),
      version: PLUGIN_VERSION,
      policy: {
        enabled: POLICY.enabled,
        allowPurge: POLICY.allowPurge,
        allowSubagentDelete: POLICY.allowSubagentDelete,
        protectPinned: POLICY.protectPinned,
        protectArchived: POLICY.protectArchived,
        requireVerifiedSession: POLICY.requireVerifiedSession,
        maxBatchSize: POLICY.maxBatchSize,
        maxPending: POLICY.maxPending,
        trashKeepDays: POLICY.trashKeepDays,
        processPendingOnStartup: POLICY.processPendingOnStartup,
        configErrors: POLICY.configErrors,
      },
      capabilities: {
        workspaceRegistry: Boolean(getWorkspaceRegistry()),
        sessionPersistence: Boolean(getPersistence()),
        connection: Boolean(connectionFence()),
        activity: typeof ctx.waterfall === 'function' && Boolean(getWorkspaceRegistry()),
      },
      counts: {
        sessions: listed.sessions.length,
        trash: trash.length,
        orphans: orphans.length,
        pending: pending.items.length,
        repairs: repairs.items.length,
      },
      warnings: [...listed.warnings, ...(pending.corrupt ? [pending.error] : []), ...(repairs.corrupt ? [repairs.error] : [])].slice(0, 50),
      audit: { ok: !logWriteError, writeError: logWriteError ? safeString(logWriteError, 300) : null },
      sweep: lastSweep
        ? { removed: lastSweep.removed, skipped: lastSweep.skipped, skippedCodes: lastSweep.skippedCodes }
        : null,
      startup: startupReport.map((row) => ({ result: row.result, code: row.code })),
      recovery: recoveryReport.map((row) => ({ result: row.result, code: row.code, reason: row.reason })),
      // Deliberately no session titles, workspace paths, absolute roots, or
      // log contents: diagnostics are safe to hand to a maintainer by default.
      redacted: true,
    })
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
                            `${session.live ? '[使用中] ' : ''}${session.kind === 'subagent' ? '[子代理] ' : ''}${session.title || '(无标题)'} — ${session.id} — ${Math.round(session.bytes / 1024)} KB${session.deletable ? '' : ` — [${session.blockedReason}]`}`,
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
                    const result = await withMutation(() =>
                      moveToTrash(arg, { reason: 'command', requestId: `command:${arg}:${Date.now()}` }),
                    )
                    return {
                      kind: 'success',
                      text: `已移入回收站：${arg}（条目 ${result.entryId}）${result.refsPending ? '；侧边栏引用待修复' : ''}`,
                    }
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
                    return { kind: 'success', text: `已排入待删除：${arg}（${POLICY.processPendingOnStartup ? '下次启动处理' : '需在面板中确认执行'}）` }
                  }
                  case 'unqueue': {
                    await withMutation(async () => unqueue(arg))
                    return { kind: 'success', text: `已取消排队：${arg}` }
                  }
                  case 'restore': {
                    const result = await withMutation(() => restore(arg))
                    return {
                      kind: 'success',
                      text: `已还原：${result.sessionId}${result.partial ? '（部分投影缓存保留在回收站）' : ''}${result.warnings?.length ? `；${result.warnings.length} 条警告` : ''}`,
                    }
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
                    const ids = validTrashEntries().map((entry) => entry.entryId)
                    if (!ids.length) return { kind: 'success', text: '回收站是空的。' }
                    const result = await withMutation(async () => purgeAll(ids, word, ids.length))
                    return { kind: 'success', text: `回收站已清空（${result.count} 条，跳过 ${result.skipped.length} 条）` }
                  }
                  default:
                    return { kind: 'error', text: `未知子命令：${sub}\n${COMMAND_HELP}` }
                }
              } catch (error) {
                log({ action: 'command-failed', sub: safeString(String(rawInput ?? '').split(/\s+/)[0] ?? '', 40), code: error instanceof HttpError ? error.code : 'error', error: safeString(error?.message ?? error, 500) })
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
    assertNoSymlinkAncestors(TRASH_DIR, DATA_DIR)
  } catch (error) {
    log({ action: 'data-dir-failed', error: String(error?.message ?? error) })
  }

  async function runStartup() {
    try {
      await withMutation(async () => {
        recoverTrash()
        if (POLICY.configErrors.length || !POLICY.enabled) {
          startupReport = readPending().map((item) => ({ sessionId: item.sessionId, result: 'deferred' }))
          return
        }
        // Reference repair must precede retention cleanup: otherwise an
        // expired refsPending entry loses the payload and its repair metadata
        // before the retry has a chance to run.
        await retryPendingAttaches()
        await retryPendingRefs()
        await retryRepairs()
        sweepTrash()
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
