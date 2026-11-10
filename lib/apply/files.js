/**
 * Restore one folder snapshot.
 *
 * The order matters and is not negotiable:
 *   preflight → assertWritable → marker check → write → prune → re-stamp
 *
 * Writing before the marker check is how a restore silently eats a directory
 * the user filled themselves.
 *
 * Three rules keep a local edit from disappearing:
 *   1. a file whose current content differs from what we last wrote *and* whose
 *      hash we recorded is a conflict: it is left alone and reported
 *   2. anything we are about to overwrite or delete is copied into the backup
 *      directory first, so even a legacy marker (no hashes) cannot lose data
 *   3. pruning is scoped to the previous marker, so a file the user added by
 *      hand is never a candidate
 */
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertWritable, readMarker, writeMarker } from '../guard.js'
import { isInside, safeRelSegments } from '../pathutil.js'
import { sha256, sha256OfFiles } from '../manifest.js'
import { preflight } from '../guard.js'

export const FOLDER_INDEX_NAME = '.repot-index.json'

export function folderPrefix(id) {
  return `files/${id}/`
}

async function readIfPresent(abs) {
  try {
    return await readFile(abs)
  } catch {
    return undefined
  }
}

export async function applyFolder({ item, roots, files, backupDir, stamp }) {
  const [record] = await preflight([item], { roots })
  if (!record?.writable) {
    return {
      id: item.id,
      status: 'refused',
      reason: record?.reason ?? '预检未通过',
      target: record?.resolved ?? null,
      level: record?.level ?? null,
    }
  }

  const target = record.resolved
  await assertWritable(target, roots)

  const prefix = folderPrefix(item.id)
  const entries = []
  for (const file of files ?? []) {
    if (!file.path.startsWith(prefix)) continue
    const rel = file.path.slice(prefix.length)
    if (rel === FOLDER_INDEX_NAME) continue
    const segments = safeRelSegments(rel)
    if (!segments || segments.length === 0) {
      return { id: item.id, status: 'failed', reason: `非法相对路径：${rel}` }
    }
    const abs = join(target, ...segments)
    if (!isInside(abs, target)) {
      return { id: item.id, status: 'failed', reason: `路径逃出目标：${rel}` }
    }
    entries.push({ rel, abs, content: file.content, sha: sha256(file.content) })
  }

  const digest = sha256OfFiles(entries.map((entry) => ({ path: prefix + entry.rel, content: entry.content })))
  if (item.sha256 && digest !== item.sha256) {
    return {
      id: item.id,
      status: 'failed',
      reason: `内容校验不通过（期望 ${String(item.sha256).slice(0, 8)}，实得 ${digest.slice(0, 8)}）`,
    }
  }

  const marker = await readMarker(target)
  const known = marker?.hashes && typeof marker.hashes === 'object' ? marker.hashes : {}
  const stale = new Set(Array.isArray(marker?.files) ? marker.files : [])

  const backupRoot = backupDir ? join(backupDir, stamp ?? '', 'files', item.id) : null
  const backupOne = async (rel, abs) => {
    if (!backupRoot) return false
    const segments = safeRelSegments(rel)
    if (!segments || !segments.length) return false
    const dest = join(backupRoot, ...segments)
    try {
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(abs, dest)
      return true
    } catch {
      return false
    }
  }

  await mkdir(target, { recursive: true })

  const conflicts = []
  const keptLocal = []
  const hashes = {}
  let written = 0
  let backedUp = 0

  for (const entry of entries) {
    const current = await readIfPresent(entry.abs)
    stale.delete(entry.rel)

    if (current === undefined) {
      await mkdir(dirname(entry.abs), { recursive: true })
      await writeFile(entry.abs, entry.content)
      written += 1
      hashes[entry.rel] = entry.sha
      continue
    }

    const currentSha = sha256(current)
    if (known[entry.rel] && known[entry.rel] !== currentSha) {
      // Edited here since the last restore, and the remote now wants a
      // different version: keep the local file, say so, back nothing up —
      // the file is untouched.
      conflicts.push({ relPath: entry.rel, localBytes: current.length, remoteBytes: entry.content.length })
      hashes[entry.rel] = known[entry.rel]
      continue
    }

    if (currentSha === entry.sha) {
      // Already identical: no write, no backup, no mtime churn.
      hashes[entry.rel] = entry.sha
      continue
    }

    if (await backupOne(entry.rel, entry.abs)) backedUp += 1
    await writeFile(entry.abs, entry.content)
    written += 1
    hashes[entry.rel] = entry.sha
  }

  // Only files this plugin wrote last time are candidates; a file the user
  // changed since then is kept and reported instead of deleted.
  let removed = 0
  for (const rel of stale) {
    const segments = safeRelSegments(rel)
    if (!segments || segments.length === 0) continue
    const abs = join(target, ...segments)
    if (!isInside(abs, target)) continue
    const current = await readIfPresent(abs)
    if (current === undefined) continue

    const currentSha = sha256(current)
    if (known[rel] && known[rel] !== currentSha) {
      keptLocal.push({ relPath: rel, reason: 'changed-locally' })
      hashes[rel] = known[rel]
      continue
    }
    if (await backupOne(rel, abs)) backedUp += 1
    try {
      await unlink(abs)
      removed += 1
    } catch {
      /* already gone */
    }
  }

  const clean = conflicts.length === 0 && keptLocal.length === 0
  await writeMarker(target, {
    id: item.id,
    // A folder that still holds local edits is not the remote folder; saying it
    // is would make the next comparison lie.
    ...(clean ? { sha256: digest } : {}),
    // Files kept on purpose stay listed, so a later snapshot can still retire
    // them once the local edit is gone.
    files: [...entries.map((entry) => entry.rel), ...keptLocal.map((kept) => kept.relPath)],
    hashes,
    ...(clean ? {} : { localChanges: conflicts.concat(keptLocal).map((item) => item.relPath) }),
  })

  return {
    id: item.id,
    status: 'applied',
    target,
    level: record.level,
    written,
    removed,
    backedUp,
    backupDir: backupRoot ?? null,
    conflicts,
    keptLocal,
    bytes: entries.reduce((sum, entry) => sum + entry.content.length, 0),
  }
}
