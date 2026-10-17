/**
 * Path and filesystem safety helpers for dsh-delete-guard.
 *
 * This module is deliberately free of DSH imports. It owns the rules that make
 * "the plugin may only touch these paths" checkable in one place:
 *   - DSH_HOME resolution with the same precedence as @deepseek-ai/dsh-home-paths;
 *   - single path-segment validation;
 *   - lexical + canonical containment checks;
 *   - refusal to walk through symlinks/junctions (Windows reparse points).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Expand only the bare/current-user tilde forms the harness supports. */
export function expandHomePath(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/** Strip the Win32 long-path prefix so path comparisons stay ordinary. */
export function stripLongPathPrefix(value) {
  if (value.startsWith('\\\\?\\')) return value.slice(4)
  if (value.startsWith('\\\\.\\')) return value.slice(4)
  return value
}

/**
 * Resolve the harness home: explicit config, then a non-blank DSH_HOME, then
 * ~/.dsh. Mirrors @deepseek-ai/dsh-home-paths so the plugin never invents a
 * different home than the host serving it.
 */
export function resolveDshHome(configured, env = process.env, home = os.homedir()) {
  const explicit = typeof configured === 'string' && configured.trim() ? configured.trim() : undefined
  const fromEnv = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : undefined
  const selected = explicit ?? fromEnv
  const raw = selected ? expandHomePath(selected) : path.join(home, '.dsh')
  return path.resolve(raw)
}

/** Resolve a configured absolute path, expanding a supported tilde prefix. */
export function resolveConfiguredPath(value) {
  const expanded = expandHomePath(String(value).trim())
  return path.resolve(expanded)
}

/** Case-normalized absolute key for Windows-safe comparisons. */
export function compareKey(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Whether two paths name the same location. */
export function isSamePath(left, right) {
  return compareKey(left) === compareKey(right)
}

/** `lstat` that returns null only for ENOENT/ENOTDIR. */
export function lstatOrNull(target) {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

/** realpathSync.native with the long-path prefix removed. */
export function realpathNative(target) {
  return stripLongPathPrefix(fs.realpathSync.native(target))
}

/** Whether `child` is strictly below `parent` (lexically, after resolution). */
export function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  if (relative === '') return false
  if (path.isAbsolute(relative)) return false
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false
  if (relative.startsWith('../')) return false
  return true
}

/**
 * Canonicalize a path even when its final segments do not exist yet: resolve
 * the deepest existing ancestor through realpath and restore the missing
 * suffix. This is what prevents a Windows 8.3 alias or a not-yet-created child
 * from being compared by a different spelling than the OS will use.
 */
export function canonicalizeTarget(target) {
  let current = path.resolve(target)
  const missing = []
  for (;;) {
    try {
      const canonical = realpathNative(current)
      return path.join(canonical, ...missing.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/** Validate one filesystem segment (session id, workspace slug, entry id). */
export function assertSingleSegment(value, label = 'path segment') {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is empty`)
  if (value.length > 255) throw new Error(`${label} is too long`)
  if (value === '.' || value === '..') throw new Error(`${label} must not be . or ..`)
  if (value.includes('/') || value.includes('\\') || value.includes(':') || value.includes('\0')) {
    throw new Error(`${label} contains a path separator or NUL`)
  }
  if (path.basename(value) !== value || path.isAbsolute(value)) throw new Error(`${label} is not a single segment`)
  return value
}

/**
 * Reject a target whose existing ancestors under `root` contain a
 * symlink/junction. `root` itself is expected to be the canonical root; its
 * own final component is not re-checked.
 */
export function assertNoSymlinkAncestors(target, root) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  if (!isSamePath(resolvedRoot, resolvedTarget) && !isPathInside(resolvedTarget, resolvedRoot)) {
    throw new Error('target is outside the allowed root')
  }
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative === '') return
  let current = resolvedRoot
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    const stat = lstatOrNull(current)
    if (!stat) return
    if (stat.isSymbolicLink()) throw new Error(`refusing to traverse a symbolic link or junction: ${current}`)
  }
}

/** True only for an existing real directory (not a symlink/junction). */
export function isRealDirectory(target) {
  const stat = lstatOrNull(target)
  return Boolean(stat && stat.isDirectory() && !stat.isSymbolicLink())
}

/** Resolve a target under a root and refuse traversal outside it. */
export function resolveUnderRoot(root, ...segments) {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, ...segments)
  if (!isSamePath(target, resolvedRoot) && !isPathInside(target, resolvedRoot)) {
    throw new Error('resolved path is outside the allowed root')
  }
  return target
}
