/**
 * dsh-delete-guard 2.1 regression tests.
 *
 * Focused fault injection for the audit fixes: TOCTOU rollback, protection
 * fail-closed, strict config, crash recovery, projection rollback/conflicts,
 * consent sets, identity, force cleanup, roots, remote peer and audit mode.
 * Runs entirely under a disposable DSH_HOME.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import { apply } from '../index.js'

const TMP = path.join(os.tmpdir(), `dsm-2.1-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const SLUG = '--E-regression--'
const WS = 'E:\\regression'
const HAS_ZSTD = process.env.DSM_FORCE_PLAIN_LOG !== '1' && typeof zlib.zstdCompressSync === 'function'
const LOG_NAME = HAS_ZSTD ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl'
const encodeLog = (text) => (HAS_ZSTD ? zlib.zstdCompressSync(Buffer.from(text)) : Buffer.from(text))
let pass = 0
let fail = 0
let seq = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name} ${extra}`)
  }
}
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))
const uid = () => `session-${Math.random().toString(36).slice(2)}-${Date.now()}-${seq++}`
const homePath = () => path.join(TMP, `home-${seq++}`)
const sessionsRoot = (home) => path.join(home, 'sessions')
const trashRoot = (home) => path.join(home, 'session-manager', 'trash')
const metaPath = (home, entryId) => path.join(trashRoot(home), entryId, 'meta.json')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

function sessionHeader(id, options = {}) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: options.createdAt ?? Date.now(),
    cwd: options.cwd ?? WS,
    delegationDepth: options.delegationDepth ?? 0,
    isSeeded: options.isSeeded ?? false,
    ...(options.origin === 'subagent' ? { origin: 'subagent' } : {}),
    ...(options.parentSession ? { parentSession: options.parentSession } : {}),
  }
}

function writeSession(home, id, options = {}) {
  const root = options.root ?? sessionsRoot(home)
  const slug = options.slug ?? SLUG
  const dir = path.join(root, slug, id)
  fs.mkdirSync(dir, { recursive: true })
  const header = sessionHeader(id, options)
  const line = `${JSON.stringify(header)}\n`
  fs.writeFileSync(path.join(dir, LOG_NAME), encodeLog(`${line}${'x'.repeat(64)}`))
  if (options.cache !== false) {
    const cache = path.join(home, 'storages', 'session_projcache', 'sessions')
    fs.mkdirSync(cache, { recursive: true })
    fs.writeFileSync(
      path.join(cache, `${id}.json`),
      JSON.stringify({ version: 7, record: { identity: { cwd: header.cwd }, rows: { title: { val: options.title ?? id } } } }),
    )
  }
  return { dir, header, root, slug }
}

function makeRegistry({ workspaces = [], archived = [], pinned = [], detachFails = false } = {}) {
  const calls = []
  const list = () => workspaces.map((workspace) => ({
    id: workspace.id,
    path: workspace.path,
    title: workspace.title ?? workspace.id,
    sessionIds: workspace.sessionIds.slice(),
    async detachSession(id) {
      calls.push(['detach', id])
      if (detachFails) throw new Error('detach locked')
      workspace.sessionIds = workspace.sessionIds.filter((value) => value !== id)
    },
    async attachSession(id) {
      calls.push(['attach', id])
      if (!workspace.sessionIds.includes(id)) workspace.sessionIds.unshift(id)
    },
  }))
  return {
    calls,
    list,
    get archivedSessionIds() {
      return archived.slice()
    },
    get pinnedSessionIds() {
      return pinned.slice()
    },
    async archiveSession(id) {
      if (!archived.includes(id)) archived.push(id)
    },
    async unarchiveSession(id) {
      const at = archived.indexOf(id)
      if (at >= 0) archived.splice(at, 1)
    },
    async pinSession(id) {
      if (!pinned.includes(id)) pinned.unshift(id)
    },
    async unpinSession(id) {
      const at = pinned.indexOf(id)
      if (at >= 0) pinned.splice(at, 1)
    },
  }
}

function makeCtx({ registry = null, liveIds = [], waterfall = null, persistence = null } = {}) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => (liveIds.includes(id) ? { id } : undefined),
          list: () => liveIds.map((id) => ({ id })),
        }
      }
      if (name === 'sessionPersistence') {
        return {
          root: persistence?.root,
          list: async () => {
            if (persistence?.fail) throw new Error('index unavailable')
            return persistence?.items ?? []
          },
        }
      }
      if (name === 'workspaceRegistry') return registry
      if (name === 'connection') return null
      return undefined
    },
    waterfall: waterfall ?? (async (_event, _payload, fallback) => fallback()),
    inject: (_deps, callback) => callback(ctx),
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect: (callback) => {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  return { ctx, routes }
}

async function call(routes, pathname, { method = 'GET', body, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const route = routes.get(pathname)
  if (!route) throw new Error(`missing route ${pathname}`)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:3000', ...headers }
  req.socket = { remoteAddress }
  const chunks = []
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    writeHead(code) {
      this.statusCode = code
      this.headersSent = true
    },
    end(buffer) {
      this.writableEnded = true
      if (buffer) chunks.push(Buffer.from(buffer))
    },
    destroy() {
      this.writableEnded = true
    },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.statusCode, json }
}

async function fresh(config = {}, options = {}, { settle = true } = {}) {
  const home = options.home ?? homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const made = makeCtx(options)
  apply(made.ctx, config)
  if (settle) await wait(260)
  return { ...made, home }
}

const del = '/dsh-delete-guard/api/delete'
const list = '/dsh-delete-guard/api/list'
const batchDel = '/dsh-delete-guard/api/delete-batch'
const purge = '/dsh-delete-guard/api/purge'
const purgeAll = '/dsh-delete-guard/api/purge-all'
const restore = '/dsh-delete-guard/api/restore'
const processPending = '/dsh-delete-guard/api/process-pending'
const queuePath = '/dsh-delete-guard/api/queue'

// ── 1. R01: activity appearing during the async gap rolls the payload back ──
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  const written = writeSession(home, id)
  const registry = makeRegistry({ workspaces: [{ id: 'ws', path: WS, sessionIds: [id] }] })
  let calls = 0
  const { routes } = await fresh(
    { trashKeepDays: 0 },
    {
      home,
      registry,
      waterfall: async (_event, _payload, fallback) => {
        calls += 1
        return calls >= 2 ? [{ kind: 'turn' }] : fallback()
      },
    },
  )
  const result = await call(routes, del, { method: 'POST', body: { id } })
  check('R01 删除期间出现活动返回 409', result.status === 409, JSON.stringify(result.json))
  check('R01 正文已回滚到原目录', fs.existsSync(path.join(written.dir, LOG_NAME)))
  check('R01 回收站没有残留条目', fs.readdirSync(trashRoot(home)).length === 0)
}

// ── 2. R02: unreadable pinned getter fails closed, not open ─────────────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const registry = {
    list: () => [{ id: 'ws', path: WS, title: 'ws', sessionIds: [id] }],
    get pinnedSessionIds() {
      throw new Error('pin store unavailable')
    },
    get archivedSessionIds() {
      return []
    },
  }
  const { routes } = await fresh({ protectPinned: true }, { home, registry })
  const result = await call(routes, del, { method: 'POST', body: { id } })
  check('R02 置顶状态未知时拒绝删除', result.status === 403 && result.json?.code === 'protection-unknown', JSON.stringify(result.json))
  check('R02 正文仍在', fs.existsSync(path.join(sessionsRoot(home), SLUG, id)))
}

// ── 3. R03: wrong config types are visible and every mutation is blocked ───
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const { routes } = await fresh({ enabled: 'false', allowPurge: 'false', protectPinned: 'true' }, { home })
  const listed = await call(routes, list)
  check('R03 /list 仍可用并暴露 configErrors', listed.status === 200 && listed.json?.configErrors?.length >= 3, JSON.stringify(listed.json?.configErrors))
  const result = await call(routes, del, { method: 'POST', body: { id } })
  check('R03 配置无效时删除被 503 阻止', result.status === 503 && result.json?.code === 'config-invalid', JSON.stringify(result.json))
  check('R03 会话没有被移动', fs.existsSync(path.join(sessionsRoot(home), SLUG, id, LOG_NAME)))
}

// ── 4. R04: startup recovery never rmSyncs an incomplete entry ─────────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  const entryId = `20260101000000000_${id}`
  const entryDir = path.join(trashRoot(home), entryId)
  fs.mkdirSync(path.join(entryDir, 'projection'), { recursive: true })
  fs.writeFileSync(path.join(entryDir, 'projection', `${id}.json`), '{"keep":true}')
  writeJson(path.join(entryDir, 'meta.json'), {
    metaVersion: 3,
    entryId,
    sessionId: id,
    sessionDirName: id,
    workspaceSlug: SLUG,
    workspacePath: WS,
    sessionsRoot: sessionsRoot(home),
    originalPath: path.join(sessionsRoot(home), SLUG, id),
    projectionFiles: [`${id}.json`],
    projectionExpected: [`${id}.json`],
    deletedAt: new Date(Date.now() - 90 * 86400000).toISOString(),
    deletedMs: Date.now() - 90 * 86400000,
    bytes: 1,
    complete: false,
    phase: 'prepared',
    wasListed: false,
    wasArchived: false,
    wasPinned: false,
    wasArchivedKnown: true,
    wasPinnedKnown: true,
    refsPending: false,
    refsDetached: false,
    broken: false,
  })
  await fresh({ enabled: false, allowPurge: false, protectPinned: true }, { home })
  check('R04 只读启动不删除未完成条目', fs.existsSync(entryDir))
  check('R04 投影缓存副本仍在', fs.existsSync(path.join(entryDir, 'projection', `${id}.json`)))
  await fresh({ trashKeepDays: 1 }, { home })
  check('R04 可写启动也不自动 rmSync 空条目', fs.existsSync(entryDir))
  try {
    fs.rmSync(entryDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

// ── 5. R05: crash after payload move reconciles projection and refs ────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const entryId = `20260101000000001_${id}`
  const entryDir = path.join(trashRoot(home), entryId)
  fs.mkdirSync(path.join(entryDir, 'payload'), { recursive: true })
  fs.writeFileSync(path.join(entryDir, 'payload', LOG_NAME), fs.readFileSync(path.join(sessionsRoot(home), SLUG, id, LOG_NAME)))
  fs.rmSync(path.join(sessionsRoot(home), SLUG, id), { recursive: true, force: true })
  fs.mkdirSync(path.join(entryDir, 'projection'), { recursive: true })
  fs.writeFileSync(path.join(entryDir, 'projection', `${id}.json`), '{"cache":1}')
  writeJson(path.join(entryDir, 'meta.json'), {
    metaVersion: 3,
    entryId,
    sessionId: id,
    sessionDirName: id,
    workspaceSlug: SLUG,
    workspacePath: WS,
    sessionsRoot: sessionsRoot(home),
    originalPath: path.join(sessionsRoot(home), SLUG, id),
    projectionFiles: [],
    projectionExpected: [],
    deletedAt: new Date().toISOString(),
    deletedMs: Date.now(),
    bytes: 1,
    complete: false,
    phase: 'projections-moved',
    wasListed: false,
    wasArchived: false,
    wasPinned: false,
    wasArchivedKnown: true,
    wasPinnedKnown: true,
    refsPending: false,
    refsDetached: false,
    broken: false,
  })
  await fresh({}, { home })
  const meta = readJson(path.join(entryDir, 'meta.json'))
  check('R05 恢复后进入 refs-pending', meta.phase === 'refs-pending' && meta.refsPending === true, JSON.stringify(meta))
  check('R05 恢复后补全投影清单', Array.isArray(meta.projectionFiles) && meta.projectionFiles.includes(`${id}.json`), JSON.stringify(meta.projectionFiles))
}

// ── 6. R06: partial projection move rolls every file back ──────────────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  const written = writeSession(home, id)
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.writeFileSync(path.join(cache, `${id}.json.bak-a`), '{"a":1}')
  const originalRename = fs.renameSync
  let failed = false
  fs.renameSync = (from, to) => {
    if (!failed && String(to).endsWith(`${id}.json.bak-a`) && String(from).includes('session_projcache')) {
      failed = true
      throw Object.assign(new Error('simulated lock'), { code: 'EBUSY' })
    }
    return originalRename(from, to)
  }
  try {
    const { routes } = await fresh({ trashKeepDays: 0 }, { home })
    const result = await call(routes, del, { method: 'POST', body: { id } })
    check('R06 部分投影失败返回失败但带 entryId', result.status === 500 && typeof result.json?.details?.entryId === 'string', JSON.stringify(result.json))
    check('R06 正文已回滚', fs.existsSync(path.join(written.dir, LOG_NAME)))
    check('R06 已搬移的第一个缓存已回滚', fs.existsSync(path.join(cache, `${id}.json`)))
    check('R06 未留下回收站条目', fs.readdirSync(trashRoot(home)).length === 0)
  } finally {
    fs.renameSync = originalRename
  }
}

// ── 7. R07: projection conflict is a partial restore that keeps the entry ──
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const { routes } = await fresh({ trashKeepDays: 0 }, { home })
  const removed = await call(routes, del, { method: 'POST', body: { id } })
  const entryId = removed.json.entryId
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.writeFileSync(path.join(cache, `${id}.json`), '{"newer":true}')
  const restored = await call(routes, restore, { method: 'POST', body: { entryId } })
  check('R07 冲突时返回部分还原', restored.status === 200 && restored.json?.partial === true, JSON.stringify(restored.json))
  check('R07 回收站条目保留冲突副本', fs.existsSync(path.join(trashRoot(home), entryId, 'projection', `${id}.json`)))
  check('R07 正文确实已还原', fs.existsSync(path.join(sessionsRoot(home), SLUG, id, LOG_NAME)))
  check('R07 较新的缓存没有被覆盖', fs.readFileSync(path.join(cache, `${id}.json`), 'utf8').includes('newer'))
}

// ── 8. R08: too many projection files is refused before any move ───────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions')
  for (let index = 0; index < 520; index += 1) {
    fs.writeFileSync(path.join(cache, `${id}.json.bak-${index}`), '{}')
  }
  const { routes } = await fresh({ trashKeepDays: 0 }, { home })
  const result = await call(routes, del, { method: 'POST', body: { id } })
  check('R08 超过投影上限时拒绝删除', result.status === 413 && result.json?.code === 'projection-too-many', JSON.stringify(result.json))
  check('R08 正文仍在原位', fs.existsSync(path.join(sessionsRoot(home), SLUG, id, LOG_NAME)))
}

// ── 9. R09/R10: exact consent sets are required ────────────────────────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const a = uid()
  const b = uid()
  writeSession(home, a)
  writeSession(home, b)
  const { routes } = await fresh({ trashKeepDays: 0, maxBatchSize: 5 }, { home })
  const noCount = await call(routes, batchDel, { method: 'POST', body: { ids: [a, b] } })
  check('R09 批量删除缺少确认数量被拒', noCount.status === 400 && noCount.json?.code === 'confirm-required', JSON.stringify(noCount.json))
  await call(routes, del, { method: 'POST', body: { id: a } })
  await call(routes, del, { method: 'POST', body: { id: b } })
  const listed = await call(routes, list)
  const ids = listed.json.trash.map((item) => item.entryId)
  const wrongSet = await call(routes, purgeAll, { method: 'POST', body: { entryIds: [ids[0]], confirmCount: 1, typedConfirm: 'PURGE' } })
  check('R10 清空回收站拒绝过期的子集快照', wrongSet.status === 409 && wrongSet.json?.code === 'stale', JSON.stringify(wrongSet.json))
  const okSet = await call(routes, purgeAll, { method: 'POST', body: { entryIds: ids, confirmCount: ids.length, typedConfirm: 'PURGE' } })
  check('R10 精确快照可以清空', okSet.status === 200 && okSet.json?.count === ids.length, JSON.stringify(okSet.json))
}

// ── 10. R11/R12: null createdAt is not 0; unreadable identity defers ───────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const first = await fresh({ trashKeepDays: 0 }, { home })
  await call(first.routes, queuePath, { method: 'POST', body: { id } })
  const pendingFile = path.join(home, 'session-manager', 'pending.json')
  const pending = readJson(pendingFile)
  pending[0].createdAt = null
  writeJson(pendingFile, pending)
  const second = await fresh({ trashKeepDays: 0 }, { home })
  const listed = await call(second.routes, list)
  const sessionIds = listed.json.pending.map((item) => item.sessionId)
  const processed = await call(second.routes, processPending, { method: 'POST', body: { sessionIds, confirmCount: sessionIds.length } })
  check('R11 createdAt=null 不再被当成 0 而丢弃', processed.status === 200 && processed.json?.succeeded === 1, JSON.stringify(processed.json))
}
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const first = await fresh({ trashKeepDays: 0 }, { home })
  await call(first.routes, queuePath, { method: 'POST', body: { id } })
  const bogus = path.join(sessionsRoot(home), SLUG, id, LOG_NAME)
  fs.writeFileSync(bogus, 'not a session header')
  const second = await fresh({ trashKeepDays: 0 }, { home, persistence: { fail: true } })
  const listed = await call(second.routes, list)
  const sessionIds = listed.json.pending.map((item) => item.sessionId)
  const processed = await call(second.routes, processPending, { method: 'POST', body: { sessionIds, confirmCount: sessionIds.length } })
  check('R12 身份不可读时保留队列而非删除', processed.json?.remaining === 1 && processed.json?.results?.[0]?.result === 'identity-unknown', JSON.stringify(processed.json))
  check('R12 正文仍在', fs.existsSync(bogus))
}

// ── 11. R13: missing workspace is reported, not a silent success ───────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const registry = makeRegistry({ workspaces: [{ id: 'ws', path: WS, sessionIds: [id] }] })
  const first = await fresh({ trashKeepDays: 0 }, { home, registry })
  const removed = await call(first.routes, del, { method: 'POST', body: { id } })
  registry.list = () => []
  const restored = await call(first.routes, restore, { method: 'POST', body: { entryId: removed.json.entryId } })
  check('R13 工作区消失时返回警告', restored.status === 200 && restored.json?.warnings?.some((line) => line.includes('工作区')), JSON.stringify(restored.json))
  check('R13 refs 不误报为成功', restored.json?.refs === false, JSON.stringify(restored.json))
}

// ── 12. R14: refsPending entries are repaired before sweep and never swept ─
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  const written = writeSession(home, id)
  const entryId = `20250101000000000_${id}`
  const entryDir = path.join(trashRoot(home), entryId)
  fs.mkdirSync(path.join(entryDir, 'payload'), { recursive: true })
  fs.copyFileSync(path.join(written.dir, LOG_NAME), path.join(entryDir, 'payload', LOG_NAME))
  fs.rmSync(written.dir, { recursive: true, force: true })
  writeJson(path.join(entryDir, 'meta.json'), {
    metaVersion: 3,
    entryId,
    sessionId: id,
    sessionDirName: id,
    workspaceSlug: SLUG,
    workspacePath: WS,
    sessionsRoot: sessionsRoot(home),
    originalPath: path.join(sessionsRoot(home), SLUG, id),
    projectionFiles: [],
    projectionExpected: [],
    deletedAt: new Date(Date.now() - 90 * 86400000).toISOString(),
    deletedMs: Date.now() - 90 * 86400000,
    bytes: 1,
    complete: true,
    phase: 'refs-pending',
    wasListed: true,
    wasArchived: false,
    wasPinned: false,
    wasArchivedKnown: true,
    wasPinnedKnown: true,
    refsPending: true,
    refsDetached: false,
    broken: false,
  })
  const registry = makeRegistry({ workspaces: [{ id: 'ws', path: WS, sessionIds: [id] }], detachFails: true })
  await fresh({ trashKeepDays: 1 }, { home, registry })
  check('R14 refsPending 条目不会被超期清理', fs.existsSync(entryDir))
}

// ── 13. R15/R16: corrupt stores are quarantined; post-commit failure is 200 ─
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const pendingFile = path.join(home, 'session-manager', 'pending.json')
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true })
  fs.writeFileSync(pendingFile, '{not-json')
  const { routes } = await fresh({ trashKeepDays: 0 }, { home })
  const queued = await call(routes, queuePath, { method: 'POST', body: { id } })
  check('R15 损坏的 pending.json 被隔离而非覆盖', queued.status === 200 && typeof queued.json?.quarantined === 'string', JSON.stringify(queued.json))
  check('R15 隔离文件保留了旧内容', fs.readdirSync(path.dirname(pendingFile)).some((name) => name.startsWith('pending.json.corrupt-')))
}
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const pendingFile = path.join(home, 'session-manager', 'pending.json')
  fs.mkdirSync(pendingFile, { recursive: true })
  const { routes } = await fresh({ trashKeepDays: 0 }, { home })
  const result = await call(routes, del, { method: 'POST', body: { id } })
  check('R16 正文已提交时仍返回 entryId/200', result.status === 200 && typeof result.json?.entryId === 'string' && result.json?.committed === true, JSON.stringify(result.json))
  check('R16 失败步骤作为警告返回', result.json?.warnings?.some((line) => line.includes('pending')), JSON.stringify(result.json?.warnings))
}

// ── 14. R17: root change requires explicit relocation ──────────────────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  const rootA = path.join(home, 'root-a')
  const rootB = path.join(home, 'root-b')
  writeSession(home, id, { root: rootA })
  const first = await fresh({ trashKeepDays: 0, sessionsRoot: rootA }, { home })
  const removed = await call(first.routes, del, { method: 'POST', body: { id } })
  const second = await fresh({ trashKeepDays: 0, sessionsRoot: rootB }, { home })
  const denied = await call(second.routes, restore, { method: 'POST', body: { entryId: removed.json.entryId } })
  check('R17 根变更时默认拒绝还原', denied.status === 409 && denied.json?.code === 'root-changed', JSON.stringify(denied.json))
  const allowed = await call(second.routes, restore, { method: 'POST', body: { entryId: removed.json.entryId, relocate: true } })
  check('R17 显式迁移可以还原到当前根', allowed.status === 200 && fs.existsSync(path.join(rootB, SLUG, id, LOG_NAME)), JSON.stringify(allowed.json))
}

// ── 15. R18/R19: file type, header identity and header kind ────────────────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const decoy = 'session-decoy0001'
  const fake = path.join(sessionsRoot(home), SLUG, decoy)
  fs.mkdirSync(path.join(fake, 'session.jsonl'), { recursive: true })
  fs.writeFileSync(path.join(fake, 'notes.txt'), 'not a session')
  const unverified = 'session-unverified1'
  const bad = path.join(sessionsRoot(home), SLUG, unverified)
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(path.join(bad, 'session.v4.jsonl'), 'not a header')
  const { routes } = await fresh({ trashKeepDays: 0 }, { home })
  const listed = await call(routes, list)
  check('R18 名为 session.jsonl 的子目录不被列出', !listed.json.sessions.some((item) => item.id === decoy))
  const row = listed.json.sessions.find((item) => item.id === unverified)
  check('R18 无有效 header 的目录标为未验证/不可删', Boolean(row) && row.unverified === true && row.deletable === false, JSON.stringify(row))
  const result = await call(routes, del, { method: 'POST', body: { id: unverified } })
  check('R18 未验证身份拒绝删除', result.status === 409 && result.json?.code === 'identity-unknown', JSON.stringify(result.json))
}
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id, { origin: 'subagent', parentSession: 'session-parent0001' })
  const { routes } = await fresh({ trashKeepDays: 0, allowSubagentDelete: false }, { home })
  const listed = await call(routes, list)
  check('R19 列表与策略使用同一 header kind', listed.json.sessions.find((item) => item.id === id)?.kind === 'subagent')
  const result = await call(routes, del, { method: 'POST', body: { id } })
  check('R19 session- 前缀的子代理也被保护', result.status === 403 && result.json?.code === 'subagent-protected', JSON.stringify(result.json))
}

// ── 15b. R18: large zstd logs use the first frame for header identity ──────
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  const dir = path.join(sessionsRoot(home), SLUG, id)
  fs.mkdirSync(dir, { recursive: true })
  const header = sessionHeader(id)
  const largeBody = Buffer.from('x'.repeat(2 * 1024 * 1024))
  const artifact = HAS_ZSTD
    ? Buffer.concat([
        zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`)),
        zlib.zstdCompressSync(largeBody),
      ])
    : Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), largeBody])
  fs.writeFileSync(path.join(dir, LOG_NAME), artifact)
  const { routes } = await fresh({ trashKeepDays: 0 }, { home })
  const listed = await call(routes, list)
  const row = listed.json.sessions.find((item) => item.id === id)
  check(`R18 大${HAS_ZSTD ? ' zstd ' : ''}日志仍能读出首帧身份`, Boolean(row) && row.unverified === false, JSON.stringify(row))
  const removed = await call(routes, del, { method: 'POST', body: { id } })
  check(`R18 大${HAS_ZSTD ? ' zstd ' : ''}日志可以正常删除`, removed.status === 200, JSON.stringify(removed.json))
}

// ── 16. R20: missing payload is detected at purge time; force needs word ───
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const { routes } = await fresh({ trashKeepDays: 0, requireTypedConfirmAt: 1 }, { home })
  const removed = await call(routes, del, { method: 'POST', body: { id } })
  const entryId = removed.json.entryId
  fs.rmSync(path.join(trashRoot(home), entryId, 'payload'), { recursive: true, force: true })
  const blocked = await call(routes, purge, { method: 'POST', body: { entryId, typedConfirm: 'PURGE' } })
  check('R20 缺少 payload 时普通 purge 被拒', blocked.status === 403 && blocked.json?.code === 'broken', JSON.stringify(blocked.json))
  const forced = await call(routes, purge, { method: 'POST', body: { entryId, typedConfirm: 'PURGE', force: true } })
  check('R20 显式 force 可以清理损坏条目', forced.status === 200, JSON.stringify(forced.json))
}

// ── 17. R21/R22: unsafe data root and non-loopback peer ────────────────────
if (process.platform === 'win32') {
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const outside = path.join(TMP, 'outside-data')
  fs.mkdirSync(outside, { recursive: true })
  try {
    fs.symlinkSync(outside, path.join(home, 'session-manager'), 'junction')
    let threw = false
    try {
      const made = makeCtx({})
      apply(made.ctx, {})
    } catch (error) {
      threw = error?.code === 'unsafe-root'
    }
    check('R21 session-manager junction 被拒绝启动', threw)
  } catch (error) {
    console.log(`skip junction root test: ${error.message}`)
  } finally {
    try {
      fs.rmSync(path.join(home, 'session-manager'), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
{
  const home = homePath()
  fs.mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const { routes } = await fresh({}, { home })
  const denied = await call(routes, list, { remoteAddress: '10.0.0.5', headers: { host: '127.0.0.1:3000' } })
  check('R22 非回环 TCP 对端不能靠 Host 伪装通过', denied.status === 403)
}

// ── 18. R23: strong audit blocks a purge when the log is unwritable ────────
{
  const home = homePath()
  fs.mkdirSync(path.join(home, 'session-manager', 'log.jsonl'), { recursive: true })
  process.env.DSH_HOME = home
  const id = uid()
  writeSession(home, id)
  const { routes } = await fresh({ trashKeepDays: 0, requireTypedConfirmAt: 1 }, { home })
  const removed = await call(routes, del, { method: 'POST', body: { id } })
  const result = await call(routes, purge, {
    method: 'POST',
    body: { entryId: removed.json?.entryId, typedConfirm: 'PURGE' },
  })
  check('R23 审计写入失败时强审计拒绝 purge', result.status === 503 && result.json?.code === 'audit-required', JSON.stringify(result.json))
  check('R23 条目仍在', fs.existsSync(path.join(trashRoot(home), removed.json?.entryId ?? 'missing')))
}

console.log(`\n2.1 回归：${pass} 通过 / ${fail} 失败`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
