/**
 * Per-file truth for one folder.
 *
 * A folder has no version number: its identity is the digest of its files. That
 * answers "same or not", but never "which file" — and "which file" is the only
 * question worth asking before a restore overwrites something.
 *
 * The hashing here is deliberately incremental: one file is read at a time and
 * dropped, so a 500 MB folder costs 500 MB of reads but not 500 MB of heap. The
 * tree digest is built with the exact same rule as the uploader
 * (`sha256OfFiles` over `files/<id>/<rel>`), so the two can never disagree.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { sha256 } from './manifest.js'
import { walk } from './scan/walk.js'

/** Stable comparison key for a folder file, identical to the uploader's. */
export function folderFilePath(id, relPath) {
  return `files/${id}/${relPath}`
}

/**
 * @returns {Promise<{id: string, sha256: string, files: Array<{relPath, bytes, sha256}>,
 *   fileCount: number, bytes: number, truncated: boolean, skipped: number}>}
 */
export async function hashFolder({ id, absPath, limits = {} }) {
  const walked = await walk(absPath, {
    maxFileBytes: limits.maxFileMB ? limits.maxFileMB * 1024 * 1024 : undefined,
    maxTotalBytes: limits.maxSetMB ? limits.maxSetMB * 1024 * 1024 : undefined,
  })

  const sorted = walked.files
    .map((file) => ({ ...file, path: folderFilePath(id, file.rel) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const hash = createHash('sha256')
  const files = []
  let bytes = 0
  for (const file of sorted) {
    const content = await readFile(file.abs)
    hash.update(file.path)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
    files.push({ relPath: file.rel, bytes: content.length, sha256: sha256(content) })
    bytes += content.length
  }

  return {
    id,
    sha256: hash.digest('hex'),
    files,
    fileCount: files.length,
    bytes,
    truncated: walked.truncated,
    skipped: walked.skipped.length,
  }
}

/** Entries of a remote folder index, normalised to `{relPath, bytes, sha256?}`. */
export function indexFiles(index) {
  return (index?.files ?? []).map((file) => ({
    relPath: file.relPath,
    bytes: file.bytes ?? 0,
    ...(file.sha256 ? { sha256: file.sha256 } : {}),
  }))
}

/**
 * What a restore would do to this folder, file by file.
 *
 * `supported: false` means the remote index predates per-file hashes, so the
 * only honest answer is the tree-level one.
 */
export function diffFolder(remoteFiles = [], localFiles = []) {
  const empty = { supported: true, added: [], changed: [], removed: [], counts: { added: 0, changed: 0, removed: 0 } }
  if (!remoteFiles.length && !localFiles.length) return empty
  if (remoteFiles.some((file) => !file.sha256)) return { ...empty, supported: false }

  const local = new Map(localFiles.map((file) => [file.relPath, file]))
  const remote = new Map(remoteFiles.map((file) => [file.relPath, file]))
  const added = []
  const changed = []
  const removed = []

  for (const [relPath, file] of remote) {
    const mine = local.get(relPath)
    if (!mine) {
      added.push({ relPath, bytes: file.bytes ?? 0 })
      continue
    }
    if (file.sha256 !== mine.sha256) {
      changed.push({ relPath, remoteBytes: file.bytes ?? 0, localBytes: mine.bytes ?? 0 })
    }
  }
  for (const [relPath, file] of local) {
    if (!remote.has(relPath)) removed.push({ relPath, bytes: file.bytes ?? 0 })
  }

  return {
    supported: true,
    added,
    changed,
    removed,
    counts: { added: added.length, changed: changed.length, removed: removed.length },
  }
}
