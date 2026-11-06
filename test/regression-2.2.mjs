/**
 * dsh-delete-guard 2.2 regression tests (DSH 0.2.2-rc.1).
 *
 * Covers the 0.2.2-specific contracts:
 * - ordinary conversation forks are independent, not subagents;
 * - real subagent headers still classify as subagents (UUID ids included);
 * - `sessionPersistence.stat()` supplies identity when the bulk `list()` fails;
 * - v4 zstd session artifacts are readable when both index paths are degraded;
 * - live-session protection still wins over every other path.
 *
 * Everything runs under a disposable DSH_HOME.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const TMP = path.join(os.tmpdir(), `dsm-2.2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const SLUG = '--E-compat22--'
const WS = 'E:\\compat-2.2'
const HAS_ZSTD = process.env.DSM_FORCE_PLAIN_LOG !== '1' && typeof zlib.zstdCompressSync === 'function'
const LOG_NAME = HAS_ZSTD ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl'
const encodeLog = (text) => (HAS_ZSTD ? zlib.zstdCompressSync(Buffer.from(text)) : Buffer.from(text))

const MAIN = 'session-11111111-1111-4111-8111-111111111111'
const FORK_NEW = 'session-22222222-2222-4222-8222-222222222222'
const FORK_LEGACY = 'session-33333333-3333-4333-8333-333333333333'
const SUBAGENT = '44444444-4444-4444-8444-444444444444'

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
let seq = 0
const freshHome = () => {
  const home = path.join(TMP, `home-${seq++}`)
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  return home
}
const writeSession = (home, id, header, options = {}) => {
  const slug = options.slug ?? SLUG
  const dir = path.join(home, 'sessions', slug, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, LOG_NAME),
    encodeLog(`${JSON.stringify(header)}\n${options.body ?? 'x'.repeat(96)}`),
  )
  return dir
}
const header = (id, extra = {}) => ({
  type: 'session',
  version: 4,
  id,
  createdAt: extra.createdAt ?? 1_800_000_000_000,
  cwd: extra.cwd ?? WS,
  isSeeded: extra.isSeeded ?? false,
  delegationDepth: extra.delegationDepth ?? 0,
  ...(extra.parentSession ? { parentSession: extra.parentSession } : {}),
  ...(extra.origin === 'subagent' ? { origin: 'subagent' } : {}),
})
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const writeWorkspace = (home, sessionIds) => {
  const file = path.join(home, 'storages', 'workspace.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { 'ws-1': { path: WS, title: 'compat-2.2', sessionIds } } },
  }, null, 2))
  return file
}

function makeCtx({ home, headers = [], liveIds = [], listMode = 'ok' }) {
  const routes = new Map()
  const persistence = {
    root: path.join(home, 'sessions'),
    list: async () => {
      if (listMode === 'throw') throw new Error('bulk session index unavailable')
      if (listMode === 'empty') return []
      return headers.map((item) => ({ header: item, sizeBytes: 128 }))
    },
    stat: async (id) => {
      if (listMode === 'throw' && headers.some((item) => item.id === id)) {
        const found = headers.find((item) => item.id === id)
        return { header: found, sizeBytes: 128 }
      }
      if (listMode === 'empty') return undefined
      return headers.some((item) => item.id === id) ? { header: headers.find((item) => item.id === id), sizeBytes: 128 } : undefined
    },
  }
  const ctx = {
    get: (name) => {
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') {
        return {
          list: () => liveIds.map((id) => ({ id, header: { id } })),
          get: (id) => (liveIds.includes(id) ? { id, header: { id } } : undefined),
        }
      }
      if (name === 'workspaceRegistry') return null
      if (name === 'connection') return null
      if (name === 'commands') return null
      return undefined
    },
    inject: (_deps, callback) => callback(ctx),
    waterfall: async (_event, _payload, fallback) => fallback(),
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

async function call(routes, pathname, { method = 'GET', body } = {}) {
  const route = routes.get(pathname)
  if (!route) throw new Error(`route missing: ${pathname}`)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: '127.0.0.1:3000' }
  req.socket = { remoteAddress: '127.0.0.1' }
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

const listPath = '/dsh-delete-guard/api/list'
const delPath = '/dsh-delete-guard/api/delete'

// ── A. bulk list degraded, targeted stat keeps identity verification alive ──
{
  const home = freshHome()
  const mainHeader = header(MAIN)
  writeSession(home, MAIN, mainHeader)
  writeWorkspace(home, [MAIN])
  const { ctx, routes } = makeCtx({ home, headers: [mainHeader], listMode: 'throw' })
  apply(ctx, { dshHome: home, requireVerifiedSession: true })
  const listed = await call(routes, listPath)
  const row = listed.json?.sessions?.find((item) => item.id === MAIN)
  check('stat fallback: /list 200', listed.status === 200, JSON.stringify(listed.json))
  check('stat fallback: identity verified', row?.unverified === false, JSON.stringify(row))
  check('stat fallback: kind main', row?.kind === 'main', JSON.stringify(row))
  const deleted = await call(routes, delPath, { method: 'POST', body: { id: MAIN } })
  check('stat fallback: delete succeeds', deleted.status === 200 && deleted.json?.ok === true, JSON.stringify(deleted.json))
}

// ── B. 0.2.2 ordinary fork (no parent/origin) is a main session ─────────────
{
  const home = freshHome()
  const forkHeader = header(FORK_NEW, { isSeeded: true, delegationDepth: 0 })
  writeSession(home, FORK_NEW, forkHeader)
  writeWorkspace(home, [FORK_NEW])
  const { ctx, routes } = makeCtx({ home, headers: [forkHeader] })
  apply(ctx, { dshHome: home, allowSubagentDelete: false })
  const listed = await call(routes, listPath)
  const row = listed.json?.sessions?.find((item) => item.id === FORK_NEW)
  check('new fork: kind main', row?.kind === 'main', JSON.stringify(row))
  check('new fork: not subagent-protected', row?.deletable === true, JSON.stringify(row))
  const deleted = await call(routes, delPath, { method: 'POST', body: { id: FORK_NEW } })
  check('new fork: delete succeeds', deleted.status === 200, JSON.stringify(deleted.json))
}

// ── C. legacy fork descriptor (parentSession + isSeeded, depth 0) is main ────
{
  const home = freshHome()
  const forkHeader = header(FORK_LEGACY, { isSeeded: true, delegationDepth: 0, parentSession: MAIN })
  writeSession(home, FORK_LEGACY, forkHeader)
  writeWorkspace(home, [FORK_LEGACY])
  const { ctx, routes } = makeCtx({ home, headers: [forkHeader] })
  apply(ctx, { dshHome: home, allowSubagentDelete: false })
  const listed = await call(routes, listPath)
  const row = listed.json?.sessions?.find((item) => item.id === FORK_LEGACY)
  check('legacy fork: kind main', row?.kind === 'main', JSON.stringify(row))
  check('legacy fork: deletable', row?.deletable === true, JSON.stringify(row))
}

// ── D. real subagent (UUID + origin) is still protected ─────────────────────
{
  const home = freshHome()
  const parentHeader = header(MAIN)
  const childHeader = header(SUBAGENT, { origin: 'subagent', parentSession: MAIN, delegationDepth: 1 })
  writeSession(home, MAIN, parentHeader)
  writeSession(home, SUBAGENT, childHeader)
  writeWorkspace(home, [MAIN])
  const { ctx, routes } = makeCtx({ home, headers: [parentHeader, childHeader] })
  apply(ctx, { dshHome: home, allowSubagentDelete: false })
  const listed = await call(routes, listPath)
  const row = listed.json?.sessions?.find((item) => item.id === SUBAGENT)
  check('subagent: kind subagent', row?.kind === 'subagent', JSON.stringify(row))
  check('subagent: blocked', row?.blockedReason === 'subagent-protected', JSON.stringify(row))
  const deleted = await call(routes, delPath, { method: 'POST', body: { id: SUBAGENT } })
  check('subagent: delete 403', deleted.status === 403 && deleted.json?.code === 'subagent-protected', JSON.stringify(deleted.json))
}

// ── E. live session wins over identity/fork classification ───────────────────
{
  const home = freshHome()
  const mainHeader = header(MAIN)
  writeSession(home, MAIN, mainHeader)
  writeWorkspace(home, [MAIN])
  const { ctx, routes } = makeCtx({ home, headers: [mainHeader], liveIds: [MAIN] })
  apply(ctx, { dshHome: home })
  const listed = await call(routes, listPath)
  const row = listed.json?.sessions?.find((item) => item.id === MAIN)
  check('live: marked live', row?.live === true && row?.blockedReason === 'live', JSON.stringify(row))
  const deleted = await call(routes, delPath, { method: 'POST', body: { id: MAIN } })
  check('live: delete 409', deleted.status === 409 && deleted.json?.code === 'live', JSON.stringify(deleted.json))
}

// ── F. v4 zstd header still readable with list+stat both unavailable ─────────
{
  const home = freshHome()
  const mainHeader = header(MAIN)
  writeSession(home, MAIN, mainHeader)
  writeWorkspace(home, [MAIN])
  const { ctx, routes } = makeCtx({ home, headers: [], listMode: 'empty' })
  apply(ctx, { dshHome: home, requireVerifiedSession: true })
  const listed = await call(routes, listPath)
  const row = listed.json?.sessions?.find((item) => item.id === MAIN)
  check('log header fallback: listed', Boolean(row), JSON.stringify(listed.json))
  check('log header fallback: verified', row?.unverified === false, JSON.stringify(row))
  const deleted = await call(routes, delPath, { method: 'POST', body: { id: MAIN } })
  check('log header fallback: delete succeeds', deleted.status === 200, JSON.stringify(deleted.json))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n2.2 兼容回归：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
