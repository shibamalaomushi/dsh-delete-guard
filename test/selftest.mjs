/**
 * dsh-delete-guard 端到端自测（0.2.1 适配版）
 *
 * 在一次性假 DSH_HOME 上驱动 Host 半身，不触碰真实数据。覆盖：
 * 0.2.1 根目录/注册表、删除→回收站→还原、meta 篡改、自动清理策略、
 * junction 还原防护、批量响应、后台工作拒绝、服务端确认词、归档/置顶恢复、
 * 排队默认不执行、日志轮转、信任围栏、启动恢复。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const TMP = path.join(os.tmpdir(), `dsm-selftest-${Date.now()}`)
const HOME = path.join(TMP, '.dsh')
const SESS = path.join(HOME, 'sessions')
const CACHE = path.join(HOME, 'storages', 'session_projcache', 'sessions')
const WSJSON = path.join(HOME, 'storages', 'workspace.json')
const DATA = path.join(HOME, 'session-manager')
const TRASH = path.join(DATA, 'trash')
const LOG = path.join(DATA, 'log.jsonl')
const SLUG = '--E-fake-ws--'
const CN_PATH = 'E:\\示例目录\\proj'
const CN_SLUG = '--E-~793A~4F8B~76EE~5F55-proj--'
const A = 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const SUB = 'a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6'

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name} ${extra}`)
  }
}
const wait = (ms = 320) => new Promise((resolve) => setTimeout(resolve, ms))
const uid = () => crypto.randomUUID()
const sessionId = () => `session-${uid()}`
const sessionFile = (slug, id) => path.join(SESS, slug, id, 'session.v4.jsonl.zstd')
const cacheFile = (id) => path.join(CACHE, `${id}.json`)
const readMeta = (entryId) => JSON.parse(fs.readFileSync(path.join(TRASH, entryId, 'meta.json'), 'utf8'))
const writeMeta = (entryId, meta) => fs.writeFileSync(path.join(TRASH, entryId, 'meta.json'), JSON.stringify(meta, null, 2))
const pendingFile = () => JSON.parse(fs.readFileSync(path.join(DATA, 'pending.json'), 'utf8'))

function writeSession(root, slug, id, title, cwd, header = null) {
  fs.mkdirSync(path.join(root, slug, id), { recursive: true })
  fs.writeFileSync(path.join(root, slug, id, 'session.v4.jsonl.zstd'), 'x'.repeat(100))
  fs.mkdirSync(CACHE, { recursive: true })
  fs.writeFileSync(
    path.join(CACHE, `${id}.json`),
    JSON.stringify({ version: 7, record: { identity: { cwd }, rows: { title: { val: title } } } }),
  )
  return header
}

function writeWorkspace(doc = null) {
  const value = doc ?? {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['ws-1', 'ws-cn'],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
    tables: {
      workspaces: {
        'ws-1': { path: 'E:\\fake-ws', title: '假工作区', sessionIds: [A, B] },
        'ws-cn': { path: CN_PATH, title: '中文工作区', sessionIds: [] },
      },
    },
  }
  fs.mkdirSync(path.dirname(WSJSON), { recursive: true })
  fs.writeFileSync(WSJSON, JSON.stringify(value, null, 2))
  return value
}
const readWorkspace = () => JSON.parse(fs.readFileSync(WSJSON, 'utf8'))
const patchWorkspace = (fn) => {
  const doc = readWorkspace()
  fn(doc)
  fs.writeFileSync(WSJSON, JSON.stringify(doc, null, 2))
}

function makeRegistry(state) {
  const calls = []
  const workspaces = state.workspaces.map((workspace) => ({
    id: workspace.id,
    path: workspace.path,
    title: workspace.title,
    get sessionIds() {
      return workspace.sessionIds.slice()
    },
    async detachSession(id) {
      calls.push(['detach', id])
      workspace.sessionIds = workspace.sessionIds.filter((value) => value !== id)
    },
    async attachSession(id) {
      calls.push(['attach', id])
      if (!workspace.sessionIds.includes(id)) workspace.sessionIds.unshift(id)
    },
  }))
  return {
    calls,
    state,
    list: () => workspaces,
    get archivedSessionIds() {
      return state.archived.slice()
    },
    get pinnedSessionIds() {
      return state.pinned.slice()
    },
    async unarchiveSession(id) {
      calls.push(['unarchive', id])
      state.archived = state.archived.filter((value) => value !== id)
    },
    async unpinSession(id) {
      calls.push(['unpin', id])
      state.pinned = state.pinned.filter((value) => value !== id)
    },
    async archiveSession(id) {
      calls.push(['archive', id])
      if (!state.archived.includes(id)) state.archived.push(id)
      state.pinned = state.pinned.filter((value) => value !== id)
    },
    async pinSession(id) {
      calls.push(['pin', id])
      if (!state.pinned.includes(id)) state.pinned.unshift(id)
    },
  }
}
const registrySnapshot = () => ({
  workspaces: [{ id: 'ws-1', path: 'E:\\fake-ws', title: '假工作区', sessionIds: [A, B] }],
  archived: [],
  pinned: [],
})

function makeCtx({
  liveIds = [],
  withSessions = true,
  withActivity = false,
  withCommands = false,
  persistenceRoot = SESS,
  headers = [],
  registry = null,
  connection = null,
} = {}) {
  const routes = new Map()
  const commands = []
  const ctx = {
    get: (name) => {
      if (name === 'sessions') {
        if (!withSessions) return undefined
        return {
          list: () => liveIds.map((id) => ({ id, header: { id } })),
          get: (id) => (liveIds.includes(id) ? { id, header: { id } } : undefined),
        }
      }
      if (name === 'commands') {
        if (!withCommands) return undefined
        return {
          register: (definition) => {
            commands.push(definition)
            return () => {
              const at = commands.indexOf(definition)
              if (at >= 0) commands.splice(at, 1)
            }
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          root: persistenceRoot,
          list: async () => headers.map((item) => (item.header ? item : { header: item })),
        }
      }
      if (name === 'workspaceRegistry') return registry
      if (name === 'connection') return connection
      return undefined
    },
    waterfall: async (_event, _payload, fallback) => (withActivity ? [{ kind: 'turn' }] : fallback()),
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
  return { ctx, routes, commands }
}

async function call(routes, pathname, { method = 'GET', body, headers = {} } = {}) {
  const route = routes.get(pathname)
  if (!route) throw new Error(`route missing: ${pathname}`)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:3000', ...headers }
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

function fresh(policy = {}, options = {}) {
  const made = makeCtx(options)
  apply(made.ctx, policy)
  return made
}

const listPath = '/dsh-delete-guard/api/list'
const delPath = '/dsh-delete-guard/api/delete'
const queuePath = '/dsh-delete-guard/api/queue'
const restorePath = '/dsh-delete-guard/api/restore'
const purgePath = '/dsh-delete-guard/api/purge'
const purgeAllPath = '/dsh-delete-guard/api/purge-all'
const delBatchPath = '/dsh-delete-guard/api/delete-batch'
const restoreBatchPath = '/dsh-delete-guard/api/restore-batch'
const purgeBatchPath = '/dsh-delete-guard/api/purge-batch'
const processPendingPath = '/dsh-delete-guard/api/process-pending'

// ── setup ─────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(SESS, { recursive: true })
process.env.DSH_HOME = HOME
writeSession(SESS, SLUG, A, '标题-aaaa', 'E:\\fake-ws')
writeSession(SESS, SLUG, B, '标题-bbbb', 'E:\\fake-ws')
writeSession(SESS, CN_SLUG, 'session-cccccccc-3333-4333-8333-cccccccccccc', '中文路径会话', CN_PATH)
fs.mkdirSync(path.join(SESS, SLUG, 'not-a-session-folder'), { recursive: true })
fs.writeFileSync(path.join(SESS, SLUG, 'not-a-session-folder', 'notes.txt'), 'not a session')
writeWorkspace()

// 1) 列举、删除、还原
{
  const { ctx, routes } = makeCtx({ withCommands: true })
  apply(ctx, { trashKeepDays: 0 })
  const list1 = await call(routes, listPath)
  check('GET /list 返回 200', list1.status === 200, `status=${list1.status}`)
  check('列出三条会话', list1.json?.sessions?.length === 3, JSON.stringify(list1.json?.sessions?.map((x) => x.id)))
  check('从投影缓存读到标题', list1.json?.sessions?.find((x) => x.id === A)?.title === '标题-aaaa')
  check('非 ASCII 工作区也能归属', list1.json?.sessions?.find((x) => x.title === '中文路径会话')?.workspaceTitle === '中文工作区')
  check('诱饵目录不被列出', !list1.json?.sessions?.some((x) => x.id === 'not-a-session-folder'))

  const delA = await call(routes, delPath, { method: 'POST', body: { id: A } })
  check('删除空闲会话成功', delA.status === 200 && delA.json?.ok === true, JSON.stringify(delA.json))
  check('A 正文已移走', !fs.existsSync(path.join(SESS, SLUG, A)))
  check('B 未受影响', fs.existsSync(sessionFile(SLUG, B)))
  const wsAfterDelete = readWorkspace()
  check('workspace.json 引用已摘除', !wsAfterDelete.tables.workspaces['ws-1'].sessionIds.includes(A))
  const list2 = await call(routes, listPath)
  const entryA = list2.json.trash.find((x) => x.sessionId === A)?.entryId
  check('回收站有 A', Boolean(entryA))
  const restored = await call(routes, restorePath, { method: 'POST', body: { entryId: entryA } })
  check('A 还原成功', restored.status === 200, JSON.stringify(restored.json))
  check('A 正文回到原位', fs.existsSync(sessionFile(SLUG, A)))
  check('A 引用回到工作区', readWorkspace().tables.workspaces['ws-1'].sessionIds.includes(A))
}

// 2) 批量响应与批量还原
{
  const ids = [sessionId(), sessionId(), sessionId()]
  for (const id of ids) writeSession(SESS, SLUG, id, `批-${id.slice(-4)}`, 'E:\\fake-ws')
  const { routes } = fresh({ trashKeepDays: 0 })
  const batch = await call(routes, delBatchPath, { method: 'POST', body: { ids, confirmCount: 3 } })
  check('批量删除响应 ok 为布尔', batch.json?.ok === true, JSON.stringify(batch.json))
  check('批量删除 succeeded=3', batch.json?.succeeded === 3 && batch.json?.failed === 0, JSON.stringify(batch.json))
  check('批量删除后正文都不在了', ids.every((id) => !fs.existsSync(path.join(SESS, SLUG, id))))
  const listed = await call(routes, listPath)
  const entries = listed.json.trash.filter((x) => ids.includes(x.sessionId)).map((x) => x.entryId)
  const restored = await call(routes, restoreBatchPath, { method: 'POST', body: { entryIds: entries } })
  check('批量还原 succeeded=3', restored.json?.ok === true && restored.json?.succeeded === 3, JSON.stringify(restored.json))
  check('批量还原后正文回来', ids.every((id) => fs.existsSync(sessionFile(SLUG, id))))
}

// 3) meta 覆盖 dir / entryId 不能删除其它目录
{
  const id = sessionId()
  writeSession(SESS, SLUG, id, 'meta 篡改', 'E:\\fake-ws')
  const { routes } = fresh({ trashKeepDays: 1 })
  const del = await call(routes, delPath, { method: 'POST', body: { id } })
  const entryId = del.json.entryId
  const outside = path.join(TMP, 'outside-meta')
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  const meta = readMeta(entryId)
  meta.dir = outside
  meta.deletedAt = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
  writeMeta(entryId, meta)
  fresh({ trashKeepDays: 1 })
  await wait()
  check('meta 的 dir 不能删除外部目录', fs.existsSync(path.join(outside, 'keep.txt')))
  check('meta 篡改条目已按自身目录清理', !fs.existsSync(path.join(TRASH, entryId)))

  const id2 = sessionId()
  writeSession(SESS, SLUG, id2, 'entry 篡改', 'E:\\fake-ws')
  const del2 = await call(fresh({ trashKeepDays: 1 }).routes, delPath, { method: 'POST', body: { id: id2 } })
  const meta2 = readMeta(del2.json.entryId)
  meta2.entryId = 'hacked'
  meta2.deletedAt = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
  writeMeta(del2.json.entryId, meta2)
  fresh({ trashKeepDays: 1 })
  await wait()
  check('entryId 不一致的条目不参与自动清理', fs.existsSync(path.join(TRASH, del2.json.entryId)))
  fs.rmSync(path.join(TRASH, del2.json.entryId), { recursive: true, force: true })
}

// 4) 自动清理遵守策略
{
  const id = sessionId()
  writeSession(SESS, SLUG, id, 'policy sweep', 'E:\\fake-ws')
  const { routes } = fresh({ trashKeepDays: 0 })
  const del = await call(routes, delPath, { method: 'POST', body: { id } })
  const entryId = del.json.entryId
  const meta = readMeta(entryId)
  meta.deletedAt = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
  writeMeta(entryId, meta)
  fresh({ trashKeepDays: 1, allowPurge: false })
  await wait()
  check('allowPurge=false 时自动清理不删除', fs.existsSync(path.join(TRASH, entryId)))
  fresh({ trashKeepDays: 1, enabled: false })
  await wait()
  check('只读模式自动清理不删除', fs.existsSync(path.join(TRASH, entryId)))
  fresh({ trashKeepDays: 1, protectedSessionIds: [id] })
  await wait()
  check('protectedSessionIds 自动清理跳过', fs.existsSync(path.join(TRASH, entryId)))
  fs.rmSync(path.join(TRASH, entryId), { recursive: true, force: true })
}

// 5) 还原 junction 父目录防护
if (process.platform === 'win32') {
  const id = sessionId()
  const slug = '--E-junction-ws--'
  writeSession(SESS, slug, id, 'junction restore', 'E:\\junction-ws')
  const { routes } = fresh({ trashKeepDays: 0 })
  const del = await call(routes, delPath, { method: 'POST', body: { id } })
  const entryId = del.json.entryId
  const slugDir = path.join(SESS, slug)
  fs.rmSync(slugDir, { recursive: true, force: true })
  const outside = path.join(TMP, 'outside-junction')
  fs.mkdirSync(outside, { recursive: true })
  try {
    fs.symlinkSync(outside, slugDir, 'junction')
    const restore = await call(routes, restorePath, { method: 'POST', body: { entryId } })
    check('junction 父目录拒绝还原', restore.status === 409 && restore.json?.code === 'bad-meta', JSON.stringify(restore.json))
    check('junction 还原没有写到外部目录', !fs.existsSync(path.join(outside, id)))
  } catch (error) {
    console.log(`skip junction restore test: ${error.message}`)
  } finally {
    try {
      fs.rmSync(slugDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    fs.rmSync(outside, { recursive: true, force: true })
  }
}

// 6) 后台任务检查覆盖批量/单条
{
  const id = sessionId()
  writeSession(SESS, SLUG, id, 'activity', 'E:\\fake-ws')
  patchWorkspace((doc) => {
    doc.tables.workspaces['ws-1'].sessionIds.push(id)
  })
  const state = registrySnapshot()
  state.workspaces[0].sessionIds.push(id)
  const { routes } = fresh({ trashKeepDays: 0 }, { withActivity: true, registry: makeRegistry(state) })
  const single = await call(routes, delPath, { method: 'POST', body: { id } })
  check('单条删除有后台工作时 409/active', single.status === 409 && single.json?.code === 'active', JSON.stringify(single.json))
  const batch = await call(routes, delBatchPath, { method: 'POST', body: { ids: [id], confirmCount: 1 } })
  check('批量删除逐条执行活动检查', batch.json?.succeeded === 0 && batch.json?.results?.[0]?.code === 'active', JSON.stringify(batch.json))
  check('有后台工作的会话文件仍在', fs.existsSync(sessionFile(SLUG, id)))
}

// 7) 单条 purge 服务端确认词
{
  const id = sessionId()
  writeSession(SESS, SLUG, id, 'typed confirm', 'E:\\fake-ws')
  const { routes } = fresh({ trashKeepDays: 0, requireTypedConfirmAt: 1 })
  const del = await call(routes, delPath, { method: 'POST', body: { id } })
  const entryId = del.json.entryId
  const noWord = await call(routes, purgePath, { method: 'POST', body: { entryId } })
  check('单条 purge 缺确认词被拒', noWord.status === 400 && noWord.json?.code === 'confirm-word', JSON.stringify(noWord.json))
  const badWord = await call(routes, purgePath, { method: 'POST', body: { entryId, typedConfirm: 'NOPE' } })
  check('单条 purge 错误确认词被拒', badWord.status === 400)
  const okWord = await call(routes, purgePath, { method: 'POST', body: { entryId, typedConfirm: 'PURGE' } })
  check('单条 purge 正确确认词成功', okWord.status === 200, JSON.stringify(okWord.json))
}

// 8) workspaceRegistry 主路径：不直接写 workspace.json
{
  const id = sessionId()
  writeSession(SESS, SLUG, id, 'registry refs', 'E:\\fake-ws')
  patchWorkspace((doc) => {
    doc.tables.workspaces['ws-1'].sessionIds.push(id)
  })
  const state = registrySnapshot()
  state.workspaces[0].sessionIds.push(id)
  const registry = makeRegistry(state)
  const before = fs.readFileSync(WSJSON, 'utf8')
  const { routes } = fresh({ trashKeepDays: 0 }, { registry })
  const del = await call(routes, delPath, { method: 'POST', body: { id } })
  check('registry 模式删除成功', del.status === 200, JSON.stringify(del.json))
  check('调用 registry.detachSession', registry.calls.some(([kind, value]) => kind === 'detach' && value === id))
  check('registry 模式不直接改写 workspace.json', fs.readFileSync(WSJSON, 'utf8') === before)
  const restore = await call(routes, restorePath, { method: 'POST', body: { entryId: del.json.entryId } })
  check('registry 模式还原成功', restore.status === 200, JSON.stringify(restore.json))
  check('调用 registry.attachSession', registry.calls.some(([kind, value]) => kind === 'attach' && value === id))
}

// 9) 自定义 sessionsRoot
{
  const custom = path.join(TMP, 'custom-sessions')
  const slug = '--E-custom-ws--'
  const id = sessionId()
  writeSession(custom, slug, id, 'custom root', 'E:\\custom-ws')
  const { routes } = fresh({ trashKeepDays: 0, sessionsRoot: custom })
  const listed = await call(routes, listPath)
  check('自定义 sessionsRoot 能列出会话', listed.json?.sessions?.some((x) => x.id === id), JSON.stringify(listed.json?.sessions?.map((x) => x.id)))
  const del = await call(routes, delPath, { method: 'POST', body: { id } })
  check('自定义 sessionsRoot 能删除会话', del.status === 200 && !fs.existsSync(sessionFileIn(custom, slug, id)), JSON.stringify(del.json))
}
function sessionFileIn(root, slug, id) {
  return path.join(root, slug, id, 'session.v4.jsonl.zstd')
}

// 10) 排队默认不执行，手动确认后执行
{
  const id = sessionId()
  writeSession(SESS, SLUG, id, 'pending', 'E:\\fake-ws')
  const first = fresh({ trashKeepDays: 0 })
  await wait()
  const queued = await call(first.routes, queuePath, { method: 'POST', body: { id } })
  check('排队成功', queued.status === 200 && pendingFile().some((x) => x.sessionId === id), JSON.stringify(queued.json))
  const second = fresh({ trashKeepDays: 0 })
  await wait()
  const listed = await call(second.routes, listPath)
  check('重启后排队项仍在磁盘上', fs.existsSync(sessionFile(SLUG, id)))
  check('启动报告标为 deferred', listed.json?.startup?.some((x) => x.sessionId === id && x.result === 'deferred'), JSON.stringify(listed.json?.startup))
  const processed = await call(second.routes, processPendingPath, { method: 'POST', body: { confirmCount: 1 } })
  check('手动执行排队删除成功', processed.status === 200 && processed.json?.succeeded === 1, JSON.stringify(processed.json))
  check('排队删除后正文已移走', !fs.existsSync(path.join(SESS, SLUG, id)))
}

// 11) 归档/置顶恢复 + 定向引用更新不误伤其它字段
{
  const id = sessionId()
  writeSession(SESS, SLUG, id, 'archive restore', 'E:\\fake-ws')
  patchWorkspace((doc) => {
    doc.global.archivedSessionIds = [id]
    doc.global.pinnedSessionIds = []
    doc.global.customSessionRef = id
    doc.tables.workspaces['ws-1'].note = id
    doc.tables.workspaces['ws-1'].sessionIds.push(id)
  })
  const { routes } = fresh({ trashKeepDays: 0 })
  const del = await call(routes, delPath, { method: 'POST', body: { id } })
  check('归档会话删除成功', del.status === 200, JSON.stringify(del.json))
  const afterDelete = readWorkspace()
  check('归档集合已摘除', !afterDelete.global.archivedSessionIds.includes(id))
  check('无关字段 customSessionRef 保留', afterDelete.global.customSessionRef === id)
  check('无关字段 workspace.note 保留', afterDelete.tables.workspaces['ws-1'].note === id)
  const restore = await call(routes, restorePath, { method: 'POST', body: { entryId: del.json.entryId } })
  check('归档会话还原成功', restore.status === 200, JSON.stringify(restore.json))
  check('还原后归档状态恢复', readWorkspace().global.archivedSessionIds.includes(id))
}

// 12) 信任围栏：connection 放行受信 Host；无 connection 时回环校验
{
  const { routes } = fresh({ trashKeepDays: 0 }, { connection: { requestRejection: () => undefined } })
  const trusted = await call(routes, listPath, { headers: { host: '10.0.0.5:3000' } })
  check('connection 允许时受信 Host 可通过', trusted.status === 200, `status=${trusted.status}`)
  const fallback = fresh({ trashKeepDays: 0 })
  const denied = await call(fallback.routes, listPath, { headers: { host: '10.0.0.5:3000' } })
  check('无 connection 时非回环 Host 被拒', denied.status === 403, `status=${denied.status}`)
  const nullOrigin = await call(fallback.routes, listPath, { headers: { origin: 'null' } })
  check('无 connection 时 Origin:null 被拒', nullOrigin.status === 403, `status=${nullOrigin.status}`)
}

// 13) 请求体/批量参数硬化
{
  const { routes } = fresh({ trashKeepDays: 0 })
  const nullBody = await call(routes, delPath, { method: 'POST', body: null })
  check('null 请求体返回 400 而不是 500', nullBody.status === 400, `status=${nullBody.status}`)
  const duplicate = await call(routes, delBatchPath, { method: 'POST', body: { ids: [B, B], confirmCount: 2 } })
  check('批量重复 id 被拒', duplicate.status === 400 && duplicate.json?.code === 'duplicate', JSON.stringify(duplicate.json))
}

// 14) 日志轮转
{
  const { routes } = fresh({ trashKeepDays: 0, logMaxBytes: 256, logKeepFiles: 2 })
  for (let index = 0; index < 8; index += 1) {
    await call(routes, listPath)
    await call(routes, queuePath, { method: 'POST', body: { id: sessionId() } }).catch(() => {})
  }
  await wait()
  check('审计日志发生轮转', fs.existsSync(`${LOG}.1`), fs.existsSync(`${LOG}.1`) ? '' : 'missing .1')
  check('当前审计日志仍存在', fs.existsSync(LOG))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
