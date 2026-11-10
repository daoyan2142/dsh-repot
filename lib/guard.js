/**
 * The write fence.
 *
 * Every filesystem mutation the plugin performs goes through this module. It
 * answers one question for a target path: *is writing here provably the place
 * the user meant?* Four checks, any failure is a hard refusal — the UI never
 * gets a "maybe".
 *
 *   1. the target lives inside a registered root            (no `..` escape)
 *   2. its nearest existing ancestor realpaths inside the
 *      real path of that root                                (no junction escape)
 *   3. the root itself exists                               (realpath is defined)
 *   4. an existing target carries our marker with our id,
 *      or is absent                                          (no blind overwrite)
 */
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDriveRoot, isInside, safeRelSegments } from './pathutil.js'
import { rootFor } from './settings.js'

export const MARKER_NAME = '.repot.json'

export class GuardError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GuardError'
    this.code = code
  }
}

export function markerPath(dir) {
  return join(dir, MARKER_NAME)
}

export async function readMarker(dir) {
  try {
    return JSON.parse(await readFile(markerPath(dir), 'utf8'))
  } catch {
    return undefined
  }
}

/** Stamp a directory as ours: `{ id, sha256, savedAt }`. */
export async function writeMarker(dir, value) {
  const body = { ...value, savedAt: new Date().toISOString() }
  await writeFile(markerPath(dir), JSON.stringify(body, null, 2), 'utf8')
  return body
}

async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the nearest existing ancestor of `p` to a real path.
 * Returns `{ real, rest }` where `rest` are the still-missing segments.
 */
async function realpathOfNearest(p) {
  const missing = []
  let cur = resolve(p)
  for (;;) {
    try {
      return { real: await realpath(cur), rest: missing.slice().reverse() }
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return { real: undefined, rest: [] }
      missing.push(cur.slice(parent.length).replace(/^[\\/]+/, ''))
      cur = parent
    }
  }
}

/**
 * Prove that writing `target` is inside some root and does not escape it
 * through a junction. Throws `GuardError` otherwise.
 */
export async function assertWritable(target, roots) {
  const abs = resolve(String(target ?? ''))
  if (isDriveRoot(abs)) throw new GuardError('drive-root', '拒绝写入盘符根')

  const root = rootFor(abs, roots)
  if (!root) throw new GuardError('outside-roots', `不在任何已登记的根内：${abs}`)

  let realRoot
  try {
    realRoot = await realpath(root.path)
  } catch {
    throw new GuardError('root-missing', `根目录不存在：${root.path}`)
  }

  const nearest = await realpathOfNearest(abs)
  if (!nearest.real) throw new GuardError('no-ancestor', `无法解析路径：${abs}`)
  if (!isInside(nearest.real, realRoot)) {
    throw new GuardError('symlink-escape', `路径经链接后跳到根之外：${nearest.real}`)
  }
  return { abs, root, realRoot, existingReal: nearest.real, rest: nearest.rest }
}

/**
 * Compare a restore target with what is already on disk.
 * `{ status: 'absent' | 'adopt' | 'conflict', reason? }`
 */
export async function inspectTarget(target, itemId) {
  if (!(await pathExists(target))) return { status: 'absent' }
  const marker = await readMarker(target)
  if (marker?.id === itemId) return { status: 'adopt', marker }
  if (marker?.id) return { status: 'conflict', reason: `目标属于另一个条目（${marker.id}）`, marker }
  return { status: 'conflict', reason: '目标已存在且不是本插件创建的，拒绝覆盖' }
}

/** Every root must exist before it can be used as an anchor. */
export async function assertRootsExist(roots) {
  const missing = []
  for (const root of roots ?? []) {
    if (!(await pathExists(root.path))) missing.push(root)
  }
  if (missing.length) {
    throw new GuardError('root-missing', `根目录不存在：${missing.map((r) => r.path).join(', ')}`)
  }
}

/**
 * Resolve every item to a final path and report what would happen.
 *
 * level 1 — `absPath` exists here (same machine, same layout)
 * level 2 — `rootId` + `relPath` exists on this machine (relocated)
 * level 3 — nothing exists yet; the path would be created (needs confirmation)
 */
export async function preflight(items, { roots }) {
  const out = []
  for (const item of items ?? []) {
    const record = {
      id: item.id,
      absPath: item.absPath ?? null,
      rootId: item.rootId ?? null,
      relPath: item.relPath ?? null,
      level: 3,
      resolved: null,
      exists: false,
      status: 'absent',
      writable: false,
      conflict: null,
      reason: null,
    }

    try {
      if (item.absPath && (await pathExists(item.absPath))) {
        record.level = 1
        record.resolved = resolve(item.absPath)
      } else {
        const root = (roots ?? []).find((r) => r.id === item.rootId)
        if (!root) {
          record.conflict = 'root-not-configured'
          record.reason = `未配置根 "${item.rootId ?? '(空)'}"`
          out.push(record)
          continue
        }
        const segments = safeRelSegments(item.relPath)
        const isRootItself = item.relPath === '' || item.relPath === '.' || item.relPath == null
        if (!segments || (!isRootItself && segments.length === 0)) {
          record.conflict = 'bad-relative-path'
          record.reason = `相对路径不可用：${item.relPath ?? '(空)'}`
          out.push(record)
          continue
        }
        const candidate = isRootItself ? resolve(root.path) : join(root.path, ...segments)
        record.resolved = candidate
        record.level = (await pathExists(candidate)) ? 2 : 3
      }

      await assertWritable(record.resolved, roots)
      record.exists = await pathExists(record.resolved)
      const check = await inspectTarget(record.resolved, item.id)
      record.status = check.status
      if (check.status === 'conflict') {
        record.conflict = 'unmanaged-target'
        record.reason = check.reason
      } else {
        record.writable = true
      }
    } catch (error) {
      record.conflict = error instanceof GuardError ? error.code : 'error'
      record.reason = error?.message ?? String(error)
      record.writable = false
    }
    out.push(record)
  }
  return out
}
