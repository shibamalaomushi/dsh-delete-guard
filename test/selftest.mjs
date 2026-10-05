/**
 * dsh-delete-guard 端到端自测
 *
 * 在**一次性假 DSH_HOME** 上驱动 Host 半身，不触碰任何真实数据。覆盖：
 *   列举与标题、工作区目录名编码（含非 ASCII）、活跃判定与 fail-closed、信任围栏、
 *   活跃/运行中工作拒绝、路径守卫、删除进回收站、workspace.json 引用摘除与还原、
 *   还原目标强校验（防篡改）、回收站按保留期清理、排队与重启后处理、斜杠命令、审计日志。
 *
 * 用法：node test/selftest.mjs
 */
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
const SLUG = '--E-fake-ws--'
// 非 ASCII 工作区路径 → 目录名（按内核 projectKey 规则手算，用来校验编码实现）
const CN_PATH = 'E:\\示例目录\\proj'
const CN_SLUG = '--E-~793A~4F8B~76EE~5F55-proj--'
const A = 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'session-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const C = 'session-cccccccc-3333-4333-8333-cccccccccccc'
const MISSING = 'session-zzzzzzzz-9999-4999-8999-zzzzzzzzzzzz'
// 子代理会话：目录名是裸 uuid（没有 session- 前缀）
const SUB = 'a1b2c3d4-1111-4111-8111-a1b2c3d4e5f6'
// 诱饵：名字合法但里面没有会话日志，插件必须既不列出也不删除
const DECOY = 'not-a-session-folder'

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

function writeSession(slug, id, title, cwd) {
  fs.mkdirSync(path.join(SESS, slug, id), { recursive: true })
  fs.writeFileSync(path.join(SESS, slug, id, 'session.v4.jsonl.zstd'), 'x'.repeat(100))
  fs.mkdirSync(CACHE, { recursive: true })
  fs.writeFileSync(
    path.join(CACHE, `${id}.json`),
    JSON.stringify({ version: 7, record: { identity: { cwd }, rows: { title: { val: title } } } }),
  )
}

function setup() {
  fs.rmSync(TMP, { recursive: true, force: true })
  writeSession(SLUG, A, '标题-aaaa', 'E:\\fake-ws')
  writeSession(SLUG, B, '标题-bbbb', 'E:\\fake-ws')
  writeSession(CN_SLUG, C, '中文路径会话', CN_PATH)
  // 内核 schema 失败时留下的投影缓存残留
  fs.writeFileSync(path.join(CACHE, `${A}.json.bak.1699999999999`), '{"stale":true}')
  // 诱饵目录：名字合法但没有会话日志
  fs.mkdirSync(path.join(SESS, SLUG, DECOY), { recursive: true })
  fs.writeFileSync(path.join(SESS, SLUG, DECOY, 'notes.txt'), 'not a session log')
  fs.mkdirSync(path.dirname(WSJSON), { recursive: true })
  fs.writeFileSync(
    WSJSON,
    JSON.stringify(
      {
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['ws-1', 'ws-cn'], archivedSessionIds: [A], pinnedSessionIds: [] },
        tables: {
          workspaces: {
            'ws-1': { path: 'E:\\fake-ws', title: '假工作区', sessionIds: [A, B] },
            'ws-cn': { path: CN_PATH, title: '中文工作区', sessionIds: [C] },
          },
        },
      },
      null,
      2,
    ),
  )
}

function makeCtx(liveIds, { withSessions = true, withActivity = false, withCommands = false } = {}) {
  const routes = new Map()
  const commands = []
  const ctx = {
    get: (name) => {
      if (name === 'sessions') {
        if (!withSessions) throw new Error('service "sessions" is not available')
        return {
          list: () => liveIds.map((id) => ({ id })),
          get: (id) => (liveIds.includes(id) ? { id } : undefined),
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
      return undefined
    },
    waterfall: async (event, _payload, fallback) =>
      withActivity && event === 'workspace/session-activity' ? [{ kind: 'turn' }] : fallback(),
    inject: (deps, cb) => {
      if (deps.includes('sessions') && !withSessions) return () => {}
      if (deps.includes('commands') && !withCommands) return () => {}
      return cb(ctx)
    },
    webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    effect: (cb) => cb(),
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
    writeHead(code) { this.statusCode = code },
    end(buf) { if (buf) chunks.push(Buffer.from(buf)) },
  }
  await route.handler(req, res)
  const text = Buffer.concat(chunks).toString('utf8')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: res.statusCode, json }
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

const sessionFile = (slug, id) => path.join(SESS, slug, id, 'session.v4.jsonl.zstd')
const cacheFile = (id) => path.join(CACHE, `${id}.json`)
const readMeta = (entryId) => JSON.parse(fs.readFileSync(path.join(TRASH, entryId, 'meta.json'), 'utf8'))
const writeMeta = (entryId, meta) => fs.writeFileSync(path.join(TRASH, entryId, 'meta.json'), JSON.stringify(meta, null, 2))
const pendingList = () => JSON.parse(fs.readFileSync(path.join(DATA, 'pending.json'), 'utf8'))

/** 用一份新的路由表挂载插件（可带策略配置），用来验证同一套代码在不同策略下的行为。 */
function fresh(policy) {
  const made = makeCtx([])
  apply(made.ctx, policy ?? {})
  return made
}

/** 直接改 workspace.json 的归档/置顶集合，用来构造"受保护类别"的用例。 */
function patchWorkspace(patch) {
  const doc = JSON.parse(fs.readFileSync(WSJSON, 'utf8'))
  patch(doc)
  fs.writeFileSync(WSJSON, JSON.stringify(doc, null, 2))
}

// ─────────────────────────── 运行 ───────────────────────────
setup()
process.env.DSH_HOME = HOME
const { ctx, routes, commands } = makeCtx([B], { withCommands: true })
apply(ctx, {})

// 1) 列举
const list1 = await call(routes, listPath)
check('GET /list 返回 200', list1.status === 200, `status=${list1.status}`)
const s = list1.json?.sessions ?? []
check('列出三条会话', s.length === 3, `len=${s.length}`)
const sa = s.find((x) => x.id === A)
const sb = s.find((x) => x.id === B)
const sc = s.find((x) => x.id === C)
check('从投影缓存读到标题', sa?.title === '标题-aaaa', `title=${sa?.title}`)
check('活跃会话 liveness=live', sb?.liveness === 'live' && sb?.live === true, `liveness=${sb?.liveness}`)
check('空闲会话 liveness=free', sa?.liveness === 'free' && sa?.live === false, `liveness=${sa?.liveness}`)
check('归档标记被带出', sa?.archived === true)
check('主会话 kind=main', sa?.kind === 'main')
check('工作区标题被带出（ASCII 路径）', sa?.workspaceTitle === '假工作区', `got=${sa?.workspaceTitle}`)
check('非 ASCII 工作区路径也能匹配上', sc?.workspaceTitle === '中文工作区', `got=${sc?.workspaceTitle}`)
check('非 ASCII 目录名与本插件编码一致', fs.existsSync(path.join(SESS, CN_SLUG, C)))
check('/list 带出 dshHome 与汇总字段', typeof list1.json?.dshHome === 'string' && Array.isArray(list1.json?.trash))

// 2) 信任围栏
check('跨站请求被拒 403', (await call(routes, listPath, { headers: { 'sec-fetch-site': 'cross-site' } })).status === 403)
check('异源 Origin 被拒 403', (await call(routes, listPath, { headers: { origin: 'http://evil.example' } })).status === 403)
check('非回环 Host 被拒 403', (await call(routes, listPath, { headers: { host: '10.0.0.5:3000' } })).status === 403)
check('缺 Host 被拒 403', (await call(routes, listPath, { headers: { host: '' } })).status === 403)
check('同源请求放行 200', (await call(routes, listPath, { headers: { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' } })).status === 200)
check('方法不符 405', (await call(routes, delPath, { method: 'GET' })).status === 405)

// 3) 拒绝删除的三种情形
const delLive = await call(routes, delPath, { method: 'POST', body: { id: B } })
check('删除使用中的会话被拒 409/live', delLive.status === 409 && delLive.json?.code === 'live', `status=${delLive.status} code=${delLive.json?.code}`)
check('被拒后 B 的文件仍在', fs.existsSync(sessionFile(SLUG, B)))
const delBad = await call(routes, delPath, { method: 'POST', body: { id: '../evil' } })
check('非法 id 被拒 400', delBad.status === 400, `status=${delBad.status}`)
const delMissing = await call(routes, delPath, { method: 'POST', body: { id: MISSING } })
check('不存在的会话 404', delMissing.status === 404, `status=${delMissing.status}`)

// 4) 删除 → 回收站（只动目标那一条）
const delA = await call(routes, delPath, { method: 'POST', body: { id: A } })
check('删除空闲会话成功 200', delA.status === 200 && delA.json?.ok === true, `status=${delA.status}`)
check('A 的正文目录已移走', !fs.existsSync(path.join(SESS, SLUG, A)))
check('A 的投影缓存已移走', !fs.existsSync(cacheFile(A)))
check('A 的投影缓存 .bak 残留也已移走', !fs.existsSync(path.join(CACHE, `${A}.json.bak.1699999999999`)))
check('同工作区的 B 完全未受影响', fs.existsSync(sessionFile(SLUG, B)) && fs.existsSync(cacheFile(B)))
check('无关的中文路径会话未受影响', fs.existsSync(sessionFile(CN_SLUG, C)))
const ws1 = JSON.parse(fs.readFileSync(WSJSON, 'utf8'))
check('sessionIds 已摘掉 A', !ws1.tables.workspaces['ws-1'].sessionIds.includes(A), JSON.stringify(ws1.tables.workspaces['ws-1'].sessionIds))
check('archivedSessionIds 已摘掉 A', !ws1.global.archivedSessionIds.includes(A))
check('仍保留 B 与 C 的引用', ws1.tables.workspaces['ws-1'].sessionIds.includes(B) && ws1.tables.workspaces['ws-cn'].sessionIds.includes(C))
check('工作区标题完好且 JSON 合法', ws1.tables.workspaces['ws-cn'].title === '中文工作区')
check('留了 workspace.json 备份', fs.existsSync(`${WSJSON}.dsh-delete-guard.bak`))

const list2 = await call(routes, listPath)
check('回收站里有 1 条', list2.json?.trash?.length === 1, `len=${list2.json?.trash?.length}`)
const entryA = list2.json.trash[0].entryId

// 5) 还原
check('还原成功 200', (await call(routes, restorePath, { method: 'POST', body: { entryId: entryA } })).status === 200)
check('还原后正文回到原位', fs.existsSync(sessionFile(SLUG, A)))
check('还原后投影缓存回到原位', fs.existsSync(cacheFile(A)))
check('还原后 .bak 残留也回到原位', fs.existsSync(path.join(CACHE, `${A}.json.bak.1699999999999`)))
check('还原后引用重新写回', JSON.parse(fs.readFileSync(WSJSON, 'utf8')).tables.workspaces['ws-1'].sessionIds.includes(A))
check('还原后回收站为空', fs.readdirSync(TRASH).length === 0)

// 6) 回收站按保留期自动清理
await call(routes, delPath, { method: 'POST', body: { id: A } })
const staleEntry = (await call(routes, listPath)).json.trash[0].entryId
const staleMeta = readMeta(staleEntry)
staleMeta.deletedAt = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
writeMeta(staleEntry, staleMeta)
await call(routes, delPath, { method: 'POST', body: { id: C } })
const freshEntry = (await call(routes, listPath)).json.trash.find((x) => x.sessionId === C).entryId
const { ctx: ctxSweep, routes: routesSweep } = makeCtx([])
apply(ctxSweep, {})
const trashAfterSweep = (await call(routesSweep, listPath)).json.trash.map((x) => x.entryId)
check('超过保留期的回收站条目被自动清理', !trashAfterSweep.includes(staleEntry), trashAfterSweep.join(','))
check('未过期条目保留', trashAfterSweep.includes(freshEntry), trashAfterSweep.join(','))

// 7) 还原目标防篡改
const tamperedMeta = readMeta(freshEntry)
tamperedMeta.originalPath = path.join(TMP, 'evil', tamperedMeta.sessionId)
writeMeta(freshEntry, tamperedMeta)
const restoreTampered = await call(routesSweep, restorePath, { method: 'POST', body: { entryId: freshEntry } })
check('被篡改原路径的条目拒绝还原 409/bad-meta', restoreTampered.status === 409 && restoreTampered.json?.code === 'bad-meta', `status=${restoreTampered.status} code=${restoreTampered.json?.code}`)
check('拒绝后正文仍留在回收站', fs.existsSync(path.join(TRASH, freshEntry, 'payload')))
check('拒绝后没有写到会话根之外', !fs.existsSync(path.join(TMP, 'evil')))
check('彻底删除该条目成功', (await call(routesSweep, purgePath, { method: 'POST', body: { entryId: freshEntry } })).status === 200)
check('彻底删除后回收站为空', fs.readdirSync(TRASH).length === 0)

// 8) 排队 + 重启后处理
check('排队成功 200', (await call(routesSweep, queuePath, { method: 'POST', body: { id: B } })).status === 200)
check('排队表里有 B', pendingList().length === 1 && pendingList()[0].sessionId === B)
const { ctx: ctx2, routes: routes2 } = makeCtx([])
apply(ctx2, {})
const list3 = await call(routes2, listPath)
check('重启后 B 被自动移入回收站', list3.json?.trash?.some((t) => t.sessionId === B), JSON.stringify(list3.json?.trash?.map((t) => t.sessionId)))
check('重启后排队表已清空', pendingList().length === 0)
check('启动处理结果有记录', list3.json?.startup?.some((x) => x.sessionId === B && x.result === 'trashed'), JSON.stringify(list3.json?.startup))

// 9) 运行中工作 → 拒绝删除
const { ctx: ctx3, routes: routes3 } = makeCtx([], { withActivity: true })
apply(ctx3, {})
const delActive = await call(routes3, delPath, { method: 'POST', body: { id: B } })
check('会话仍有运行中工作时被拒 409/active', delActive.status === 409 && delActive.json?.code === 'active', `status=${delActive.status} code=${delActive.json?.code}`)

// 9.5) 子代理会话（裸 uuid 目录名）与诱饵目录
writeSession(SLUG, SUB, '子代理会话', 'E:\\fake-ws')
const { ctx: ctxSub, routes: routesSub } = makeCtx([])
apply(ctxSub, {})
const listSub = await call(routesSub, listPath)
const subEntry = listSub.json?.sessions?.find((x) => x.id === SUB)
check('子代理会话被列出且 kind=subagent', subEntry?.kind === 'subagent', JSON.stringify(subEntry))
check('没有会话日志的目录不被列出', !listSub.json?.sessions?.some((x) => x.id === DECOY))
const delDecoy = await call(routesSub, delPath, { method: 'POST', body: { id: DECOY } })
check('诱饵目录拒绝删除 404', delDecoy.status === 404, `status=${delDecoy.status} code=${delDecoy.json?.code}`)
check('诱饵目录仍在磁盘上', fs.existsSync(path.join(SESS, SLUG, DECOY, 'notes.txt')))
const delSub = await call(routesSub, delPath, { method: 'POST', body: { id: SUB } })
check('子代理会话可被删除 200', delSub.status === 200, `status=${delSub.status} code=${delSub.json?.code}`)
check('子代理会话正文已移走', !fs.existsSync(path.join(SESS, SLUG, SUB)))
const subTrash = (await call(routesSub, listPath)).json?.trash?.find((t) => t.sessionId === SUB)
check('子代理会话进入回收站', Boolean(subTrash), JSON.stringify((await call(routesSub, listPath)).json?.trash?.map((t) => t.sessionId)))
check('子代理会话可还原（还原校验接受裸 uuid）', (await call(routesSub, restorePath, { method: 'POST', body: { entryId: subTrash.entryId } })).status === 200)
check('还原后子代理会话回到原位', fs.existsSync(sessionFile(SLUG, SUB)))

// 10) fail-closed：会话服务不可用（用一条专为此准备的会话，避免被前面的用例删掉）
const D = 'session-dddddddd-4444-4444-8444-dddddddddddd'
writeSession(SLUG, D, '标题-dddd', 'E:\\fake-ws')
const { ctx: ctx4, routes: routes4 } = makeCtx([], { withSessions: false })
apply(ctx4, {})
const list4 = await call(routes4, listPath)
check('服务不可用时仍能列出（liveness=unknown）', list4.status === 200 && list4.json?.sessions?.every((x) => x.liveness === 'unknown'), `status=${list4.status}`)
check('服务不可用时占位展示为不可删', list4.json?.sessions?.every((x) => x.live === true))
const delUnknown = await call(routes4, delPath, { method: 'POST', body: { id: D } })
check('服务不可用时拒绝删除 409/live-unknown', delUnknown.status === 409 && delUnknown.json?.code === 'live-unknown', `status=${delUnknown.status} code=${delUnknown.json?.code}`)
check('拒绝后文件完好', fs.existsSync(sessionFile(SLUG, D)))

// 11) 斜杠命令
const { ctx: ctx5, routes: routes5, commands: commands5 } = makeCtx([], { withCommands: true })
apply(ctx5, {})
check('注册了 /sessions 命令', commands5.length === 1 && commands5[0].name === 'sessions', JSON.stringify(commands5.map((c) => c.name)))
const runCmd = (line) => commands5[0].handler({ rawInput: line })
check('/sessions list 返回会话清单', runCmd('list').kind === 'success' && runCmd('list').text.includes(D))
check('/sessions delete 生效', runCmd(`delete ${D}`).kind === 'success' && !fs.existsSync(path.join(SESS, SLUG, D)))
check('删除后回收站有该会话', (await call(routes5, listPath)).json.trash.some((t) => t.sessionId === D))
const cmdEntry = (await call(routes5, listPath)).json.trash[0].entryId
check('/sessions restore 生效', runCmd(`restore ${cmdEntry}`).kind === 'success' && fs.existsSync(sessionFile(SLUG, D)))
check('/sessions queue + trash 文案正常', runCmd(`queue ${D}`).kind === 'success' && runCmd('trash').kind === 'success')
check('/sessions unqueue 生效', runCmd(`unqueue ${D}`).kind === 'success' && pendingList().length === 0)
check('/sessions 未知子命令报错', runCmd('nonsense').kind === 'error')
check('/sessions delete 非法 id 返回错误而不是抛异常', runCmd('delete ../../etc').kind === 'error')

// 12) 批量操作
const B1 = 'session-b1111111-1111-4111-8111-b11111111111'
const B2 = 'session-b2222222-2222-4222-8222-b22222222222'
const B3 = 'session-b3333333-3333-4333-8333-b33333333333'
for (const [id, title] of [[B1, '批-1'], [B2, '批-2'], [B3, '批-3']]) writeSession(SLUG, id, title, 'E:\\fake-ws')
const batchIds = [B1, B2, B3]
const { routes: rBatch } = fresh()
const mismatch = await call(rBatch, delBatchPath, { method: 'POST', body: { ids: batchIds, confirmCount: 2 } })
check('批量删除：确认数量不一致被拒 400/confirm-mismatch', mismatch.status === 400 && mismatch.json?.code === 'confirm-mismatch', `status=${mismatch.status} code=${mismatch.json?.code}`)
check('被拒后三条都还在', batchIds.every((id) => fs.existsSync(sessionFile(SLUG, id))))
const batch = await call(rBatch, delBatchPath, { method: 'POST', body: { ids: batchIds, confirmCount: 3 } })
check('批量删除 3 条成功', batch.status === 200 && batch.json?.ok === 3 && batch.json?.failed === 0, JSON.stringify(batch.json))
check('批量删除后正文都不在了', batchIds.every((id) => !fs.existsSync(path.join(SESS, SLUG, id))))
check('批量删除后逐条结果可追溯', batch.json?.results?.length === 3 && batch.json.results.every((r) => r.ok && r.entryId))
const trashOf = async (routes, ids) => (await call(routes, listPath)).json.trash.filter((t) => ids.includes(t.sessionId))
const trash12 = await trashOf(rBatch, batchIds)
check('三条都在回收站里', trash12.length === 3, `len=${trash12.length}`)
const restoredBatch = await call(rBatch, restoreBatchPath, { method: 'POST', body: { entryIds: trash12.map((t) => t.entryId) } })
check('批量还原 3 条成功', restoredBatch.status === 200 && restoredBatch.json?.ok === 3, JSON.stringify(restoredBatch.json))
check('批量还原后正文回来了', batchIds.every((id) => fs.existsSync(sessionFile(SLUG, id))))
check('批量还原后这三条不再出现在回收站', (await trashOf(rBatch, batchIds)).length === 0)

// 再次删除后做批量彻底删除（3 条 ≥ 阈值 3 ⇒ 必须输入确认词）
await call(rBatch, delBatchPath, { method: 'POST', body: { ids: batchIds, confirmCount: 3 } })
const entries12 = (await trashOf(rBatch, batchIds)).map((t) => t.entryId)
check('第二次删除后目标条目为 3 条', entries12.length === 3, `len=${entries12.length}`)
const noWord = await call(rBatch, purgeBatchPath, { method: 'POST', body: { entryIds: entries12, confirmCount: 3 } })
check('批量彻底删除缺确认词被拒 400/confirm-word', noWord.status === 400 && noWord.json?.code === 'confirm-word', `status=${noWord.status} code=${noWord.json?.code}`)
const badWord = await call(rBatch, purgeBatchPath, { method: 'POST', body: { entryIds: entries12, confirmCount: 3, typedConfirm: 'nope' } })
check('批量彻底删除确认词错误被拒', badWord.status === 400)
check('被拒后目标条目仍在回收站', (await trashOf(rBatch, batchIds)).length === 3)
const purgedBatch = await call(rBatch, purgeBatchPath, { method: 'POST', body: { entryIds: entries12, confirmCount: 3, typedConfirm: 'PURGE' } })
check('批量彻底删除成功', purgedBatch.status === 200 && purgedBatch.json?.ok === 3, JSON.stringify(purgedBatch.json))
check('彻底删除后磁盘上没有了', batchIds.every((id) => !fs.existsSync(path.join(SESS, SLUG, id))))
check('彻底删除后目标条目不在回收站', (await trashOf(rBatch, batchIds)).length === 0)

// 清空回收站：高严重度 ⇒ 永远要确认词，且条数必须与界面一致（TOCTOU）
writeSession(SLUG, B1, '清空-1', 'E:\\fake-ws')
writeSession(SLUG, B2, '清空-2', 'E:\\fake-ws')
await call(rBatch, delBatchPath, { method: 'POST', body: { ids: [B1, B2], confirmCount: 2 } })
const trashCount = (await call(rBatch, listPath)).json.trash.length
check('回收站条数可读', trashCount >= 2, `count=${trashCount}`)
const stale = await call(rBatch, purgeAllPath, { method: 'POST', body: { confirmCount: trashCount + 1, typedConfirm: 'PURGE' } })
check('清空回收站：条数与实际不符被拒 409/stale', stale.status === 409 && stale.json?.code === 'stale', `status=${stale.status} code=${stale.json?.code}`)
const noWordAll = await call(rBatch, purgeAllPath, { method: 'POST', body: { confirmCount: trashCount } })
check('清空回收站：缺确认词被拒 400/confirm-word', noWordAll.status === 400 && noWordAll.json?.code === 'confirm-word', `status=${noWordAll.status} code=${noWordAll.json?.code}`)
const emptied = await call(rBatch, purgeAllPath, { method: 'POST', body: { confirmCount: trashCount, typedConfirm: 'PURGE' } })
check('清空回收站成功', emptied.status === 200 && emptied.json?.count === trashCount, JSON.stringify(emptied.json))
check('清空后回收站为空', (await call(rBatch, listPath)).json.trash.length === 0)

// 13) 策略闸门
const P1 = 'session-p1111111-1111-4111-8111-p11111111111'
writeSession(SLUG, P1, '策略-1', 'E:\\fake-ws')
const { routes: rRo } = fresh({ enabled: false })
const listRo = await call(rRo, listPath)
check('/list 带出策略', listRo.json?.policy?.enabled === false, JSON.stringify(listRo.json?.policy))
check('只读模式下会话标记为不可删', listRo.json?.sessions?.every((x) => x.deletable === false && x.blockedReason === 'disabled'))
const delRo = await call(rRo, delPath, { method: 'POST', body: { id: P1 } })
check('只读模式下删除被拒 403/disabled', delRo.status === 403 && delRo.json?.code === 'disabled', `status=${delRo.status} code=${delRo.json?.code}`)
check('只读模式下文件完好', fs.existsSync(sessionFile(SLUG, P1)))

const { routes: rCap } = fresh({ maxBatchSize: 2 })
const cap = await call(rCap, delBatchPath, { method: 'POST', body: { ids: [P1, P1, P1], confirmCount: 3 } })
check('超出 maxBatchSize 被拒 413/too-many', cap.status === 413 && cap.json?.code === 'too-many', `status=${cap.status} code=${cap.json?.code}`)

const { routes: rProt } = fresh({ protectedSessionIds: [P1] })
const delProt = await call(rProt, delPath, { method: 'POST', body: { id: P1 } })
check('protectedSessionIds 名单内被拒 403/protected', delProt.status === 403 && delProt.json?.code === 'protected', `status=${delProt.status} code=${delProt.json?.code}`)

const { routes: rSub } = fresh({ allowSubagentDelete: false })
const delSubProtected = await call(rSub, delPath, { method: 'POST', body: { id: SUB } })
check('禁止删子代理时被拒 403/subagent-protected', delSubProtected.status === 403 && delSubProtected.json?.code === 'subagent-protected', `status=${delSubProtected.status} code=${delSubProtected.json?.code}`)
check('被拒后子代理会话完好', fs.existsSync(sessionFile(SLUG, SUB)))

// 归档 / 置顶 受保护
patchWorkspace((doc) => {
  doc.global.archivedSessionIds = [P1]
  doc.global.pinnedSessionIds = [P1]
})
const { routes: rArch } = fresh({ protectArchived: true })
const delArch = await call(rArch, delPath, { method: 'POST', body: { id: P1 } })
check('protectArchived 时归档会话被拒 403/archived-protected', delArch.status === 403 && delArch.json?.code === 'archived-protected', `status=${delArch.status} code=${delArch.json?.code}`)
const { routes: rPin } = fresh({ protectPinned: true })
patchWorkspace((doc) => {
  doc.global.archivedSessionIds = []
})
const delPin = await call(rPin, delPath, { method: 'POST', body: { id: P1 } })
check('protectPinned 时置顶会话被拒 403/pinned-protected', delPin.status === 403 && delPin.json?.code === 'pinned-protected', `status=${delPin.status} code=${delPin.json?.code}`)

// 关掉彻底删除
writeSession(SLUG, P1, '策略-1', 'E:\\fake-ws')
const { routes: rNoPurge } = fresh({ allowPurge: false })
await call(rNoPurge, delPath, { method: 'POST', body: { id: P1 } })
const trashNoPurge = (await call(rNoPurge, listPath)).json.trash
const entryNoPurge = trashNoPurge.find((t) => t.sessionId === P1).entryId
const purgeDenied = await call(rNoPurge, purgePath, { method: 'POST', body: { entryId: entryNoPurge } })
check('allowPurge=false 时彻底删除被拒 403/purge-disabled', purgeDenied.status === 403 && purgeDenied.json?.code === 'purge-disabled', `status=${purgeDenied.status} code=${purgeDenied.json?.code}`)
check('被拒后该条目仍在回收站', (await call(rNoPurge, listPath)).json.trash.some((t) => t.sessionId === P1))
const purgeAllDenied = await call(rNoPurge, purgeAllPath, { method: 'POST', body: { confirmCount: trashNoPurge.length, typedConfirm: 'PURGE' } })
check('allowPurge=false 时清空回收站也被拒 403/purge-disabled', purgeAllDenied.status === 403 && purgeAllDenied.json?.code === 'purge-disabled', `status=${purgeAllDenied.status} code=${purgeAllDenied.json?.code}`)
const restoreOk = await call(rNoPurge, restorePath, { method: 'POST', body: { entryId: entryNoPurge } })
check('allowPurge=false 时仍可还原', restoreOk.status === 200, `status=${restoreOk.status}`)

// 14) 回收站里的策略一致性 + 无法归属的残留
const G1 = 'session-91111111-1111-4111-8111-91111111111'
writeSession(SLUG, G1, '保护与孤儿-1', 'E:\\fake-ws')
const { routes: rG } = fresh()
await call(rG, delPath, { method: 'POST', body: { id: G1 } })
check('G1 已入回收站', (await call(rG, listPath)).json.trash.some((t) => t.sessionId === G1))
// 模拟"策略事后收紧"：条目已经在回收站里，之后才被加入保护名单
const { routes: rG2 } = fresh({ protectedSessionIds: [G1] })
const listedG = await call(rG2, listPath)
const entryG = listedG.json.trash.find((t) => t.sessionId === G1)
check('受保护的回收站条目带出不可彻底删除原因', entryG?.purgeBlockedReason === 'protected', JSON.stringify(entryG?.purgeBlockedReason))
const purgeG = await call(rG2, purgePath, { method: 'POST', body: { entryId: entryG.entryId } })
check('受保护的回收站条目拒绝单条彻底删除 403/protected', purgeG.status === 403 && purgeG.json?.code === 'protected', `status=${purgeG.status} code=${purgeG.json?.code}`)
check('被拒后条目仍在磁盘上', fs.existsSync(path.join(TRASH, entryG.entryId, 'payload')))
const emptiedG = await call(rG2, purgeAllPath, { method: 'POST', body: { confirmCount: listedG.json.trash.length, typedConfirm: 'PURGE' } })
check('清空回收站会跳过受保护条目并如实报告', emptiedG.status === 200 && emptiedG.json?.skipped?.some((x) => x.code === 'protected'), JSON.stringify(emptiedG.json))
check('受保护条目在清空后仍在磁盘上', fs.existsSync(path.join(TRASH, entryG.entryId, 'payload')))

const orphanId = 'orphan-without-meta'
fs.mkdirSync(path.join(TRASH, orphanId, 'payload'), { recursive: true })
fs.writeFileSync(path.join(TRASH, orphanId, 'payload', 'session.v4.jsonl.zstd'), 'x')
const listedG2 = await call(rG2, listPath)
check('没有 meta 的残留不出现在列表里', !listedG2.json.trash.some((t) => t.entryId === orphanId))
const purgeOrphan = await call(rG2, purgePath, { method: 'POST', body: { entryId: orphanId } })
check('无法归属的残留拒绝单条彻底删除 403/orphan', purgeOrphan.status === 403 && purgeOrphan.json?.code === 'orphan', `status=${purgeOrphan.status} code=${purgeOrphan.json?.code}`)
const emptiedG2 = await call(rG2, purgeAllPath, { method: 'POST', body: { confirmCount: listedG2.json.trash.length, typedConfirm: 'PURGE' } })
check('清空回收站会跳过无法归属的残留并如实报告', emptiedG2.json?.skipped?.some((x) => x.code === 'orphan'), JSON.stringify(emptiedG2.json))
check('无法归属的残留在清空后仍在磁盘上（保守）', fs.existsSync(path.join(TRASH, orphanId, 'payload')))
fs.rmSync(path.join(TRASH, orphanId), { recursive: true, force: true })
fs.rmSync(path.join(TRASH, entryG.entryId), { recursive: true, force: true })

// 15) 只读模式：批量与排队都要顶层拒绝
const { routes: rRo2 } = fresh({ enabled: false })
const batchRo = await call(rRo2, delBatchPath, { method: 'POST', body: { ids: [SUB], confirmCount: 1 } })
check('只读模式下批量删除顶层被拒 403/disabled', batchRo.status === 403 && batchRo.json?.code === 'disabled', `status=${batchRo.status} code=${batchRo.json?.code}`)
const queueRo = await call(rRo2, queuePath, { method: 'POST', body: { id: SUB } })
check('只读模式下排队也被拒 403/disabled', queueRo.status === 403 && queueRo.json?.code === 'disabled', `status=${queueRo.status} code=${queueRo.json?.code}`)

// 16) 排队项若因策略变成"永久删不掉"，下次启动应被丢弃而不是无限重试
const Q1 = 'session-92222222-2222-4222-8222-92222222222'
writeSession(SLUG, Q1, '队列丢弃', 'E:\\fake-ws')
const { routes: rQ } = fresh()
check('排队成功 200', (await call(rQ, queuePath, { method: 'POST', body: { id: Q1 } })).status === 200)
check('队列里有 Q1', pendingList().some((x) => x.sessionId === Q1))
const { routes: rQ2 } = fresh({ protectedSessionIds: [Q1] })
const listQ2 = await call(rQ2, listPath)
check('永久失败的排队项被丢弃', !pendingList().some((x) => x.sessionId === Q1), JSON.stringify(pendingList()))
check('启动报告把该结果标为 dropped', listQ2.json?.startup?.some((x) => x.sessionId === Q1 && x.result === 'dropped'), JSON.stringify(listQ2.json?.startup))
check('被丢弃的会话仍在磁盘上（没有被删）', fs.existsSync(sessionFile(SLUG, Q1)))
const queueProtected = await call(rQ2, queuePath, { method: 'POST', body: { id: Q1 } })
check('受保护会话现在连排队都被拒 403/protected', queueProtected.status === 403 && queueProtected.json?.code === 'protected', `status=${queueProtected.status} code=${queueProtected.json?.code}`)

// 17) 进回收站的条目一定可归属（meta 先于正文落盘）
const M1 = 'session-93333333-3333-4333-8333-93333333333'
writeSession(SLUG, M1, '可归属', 'E:\\fake-ws')
const { routes: rM } = fresh()
const delM = await call(rM, delPath, { method: 'POST', body: { id: M1 } })
const metaM = readMeta(delM.json.entryId)
check('条目 meta 有 sessionId 与 originalPath', metaM.sessionId === M1 && typeof metaM.originalPath === 'string')
check('条目在搬完后标记为 complete', metaM.complete === true)
check('列表带出 complete 标记', (await call(rM, listPath)).json.trash.find((t) => t.sessionId === M1)?.complete === true)

// 18) 审计日志
const actions = fs
  .readFileSync(path.join(DATA, 'log.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line).action)
check(
  '审计日志含 apply/trash/restore/purge/queue/sweep-trash/process-pending 与三种批量动作',
  ['apply', 'trash', 'restore', 'purge', 'queue', 'sweep-trash', 'process-pending', 'trash-batch', 'restore-batch', 'purge-batch', 'purge-all'].every(
    (a) => actions.includes(a),
  ),
  [...new Set(actions)].join(','),
)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
