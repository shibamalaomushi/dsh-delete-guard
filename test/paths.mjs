/**
 * Path helper unit tests. These do not touch a real DSH_HOME.
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
  isSamePath,
  resolveDshHome,
  resolveUnderRoot,
  stripLongPathPrefix,
} from '../lib/paths.js'

let pass = 0
let fail = 0
const check = (name, condition, extra = '') => {
  if (condition) {
    pass += 1
    console.log(`ok   ${name}`)
  } else {
    fail += 1
    console.log(`FAIL ${name} ${extra}`)
  }
}

const fakeHome = path.join(os.tmpdir(), 'dsm-fake-home')

check('显式 dshHome 优先于 DSH_HOME', resolveDshHome('D:\\explicit', { DSH_HOME: 'E:\\env' }) === path.resolve('D:\\explicit'))
check('DSH_HOME 优先于默认 home', resolveDshHome(undefined, { DSH_HOME: 'E:\\env' }) === path.resolve('E:\\env'))
check('空白 DSH_HOME 视为未设置', resolveDshHome(undefined, { DSH_HOME: '   ' }, fakeHome) === path.join(fakeHome, '.dsh'))
check('~ 展开到当前用户 home', expandHomePath('~/x') === path.join(os.homedir(), 'x'))
check('~\\x 展开到当前用户 home', expandHomePath('~\\x') === path.join(os.homedir(), 'x'))
check('非当前用户 ~alice 不展开', expandHomePath('~alice/x') === '~alice/x')

check('单段接受普通会话 id', assertSingleSegment('session-abc123', 'id') === 'session-abc123')
for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', 'C:foo', 'a\0b']) {
  let thrown = false
  try {
    assertSingleSegment(bad, 'id')
  } catch {
    thrown = true
  }
  check(`单段拒绝 ${JSON.stringify(bad)}`, thrown)
}

check('isPathInside 接受直接子目录', isPathInside(path.join(os.tmpdir(), 'a', 'b'), path.join(os.tmpdir(), 'a')))
check('isPathInside 拒绝同级', !isPathInside(path.join(os.tmpdir(), 'a2'), path.join(os.tmpdir(), 'a')))
check('isPathInside 拒绝父目录', !isPathInside(os.tmpdir(), path.join(os.tmpdir(), 'a')))
check('isSamePath 忽略 Windows 大小写', process.platform !== 'win32' || isSamePath('C:\\A', 'c:\\a'))

if (process.platform === 'win32') {
  check('Windows 跨盘路径不是 inside', !isPathInside('C:\\session-abc123', 'E:\\dsh\\sessions'))
  check('Windows 跨盘相对结果不会被当成两段子路径', !isPathInside('C:\\session-abc123', 'E:\\dsh\\sessions'))
  check('UNC 长路径前缀还原为绝对 UNC 路径', stripLongPathPrefix('\\\\?\\UNC\\server\\share\\sessions') === '\\\\server\\share\\sessions')
  check('普通长路径前缀仍被剥离', stripLongPathPrefix('\\\\?\\E:\\dsh\\sessions') === 'E:\\dsh\\sessions')
}

let thrown = false
try {
  resolveUnderRoot('E:\\dsh\\sessions', '..', 'evil')
} catch {
  thrown = true
}
check('resolveUnderRoot 拒绝 .. 越界', process.platform !== 'win32' || thrown)

const tmp = path.join(os.tmpdir(), `dsm-paths-${Date.now()}`)
fs.mkdirSync(path.join(tmp, 'root', 'real'), { recursive: true })
try {
  const canonical = canonicalizeTarget(path.join(tmp, 'root', 'real', 'missing', 'deep'))
  check('canonicalizeTarget 保留缺失后缀', canonical.startsWith(fs.realpathSync.native(path.join(tmp, 'root', 'real'))))

  if (process.platform === 'win32') {
    const target = path.join(tmp, 'outside')
    fs.mkdirSync(target, { recursive: true })
    const link = path.join(tmp, 'root', 'junction')
    try {
      fs.symlinkSync(target, link, 'junction')
      let rejected = false
      try {
        assertNoSymlinkAncestors(path.join(link, 'x'), path.join(tmp, 'root'))
      } catch {
        rejected = true
      }
      check('拒绝 junction 祖先', rejected)
      fs.rmSync(link, { recursive: true, force: true })
    } catch (error) {
      console.log(`skip junction test: ${error.message}`)
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n路径测试：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
