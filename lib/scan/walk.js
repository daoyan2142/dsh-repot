/**
 * One filesystem walker for both scanning and packing, so the skip rules can
 * never drift apart: whatever the scanner says it will upload is exactly what
 * the packer puts in the tarball.
 *
 * Symlinks (including Windows junctions) are never followed. Following them is
 * how a "sync this folder" turns into "sync my whole drive".
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '.repot'])
// `.repot.json` is the marker this plugin writes into a restored folder. It is
// not part of the folder's content: carrying it would make every restore change
// the digest it was just restored to.
export const DEFAULT_SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', '.repot.json'])

/**
 * @param {string} root absolute directory
 * @param {object} [options]
 * @param {Set<string>} [options.skipDirs]
 * @param {Set<string>} [options.skipFiles]
 * @param {number} [options.maxFileBytes]  per-file ceiling; larger files are skipped
 * @param {number} [options.maxTotalBytes] set ceiling; the walk stops when exceeded
 * @param {(rel: string, isDir: boolean) => boolean} [options.ignore] true = skip
 * @returns {Promise<{root: string, files: Array<{abs: string, rel: string, bytes: number}>,
 *   skipped: Array<{relPath: string, reason: string}>, totalBytes: number, truncated: boolean}>}
 */
export async function walk(root, options = {}) {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS
  const skipFiles = options.skipFiles ?? DEFAULT_SKIP_FILES
  const maxFileBytes = options.maxFileBytes ?? Number.POSITIVE_INFINITY
  const maxTotalBytes = options.maxTotalBytes ?? Number.POSITIVE_INFINITY
  const ignore = options.ignore

  const files = []
  const skipped = []
  let totalBytes = 0
  let truncated = false

  async function visit(dir, rel) {
    if (truncated) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      skipped.push({ relPath: rel || '.', reason: 'unreadable' })
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const entry of entries) {
      if (truncated) return
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const abs = join(dir, entry.name)

      if (entry.isSymbolicLink()) {
        skipped.push({ relPath: childRel, reason: 'symlink' })
        continue
      }
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          skipped.push({ relPath: childRel, reason: 'skip-dir' })
          continue
        }
        if (ignore && ignore(childRel, true)) {
          skipped.push({ relPath: childRel, reason: 'ignored' })
          continue
        }
        await visit(abs, childRel)
        continue
      }
      if (!entry.isFile()) {
        skipped.push({ relPath: childRel, reason: 'special' })
        continue
      }
      if (skipFiles.has(entry.name)) {
        skipped.push({ relPath: childRel, reason: 'skip-file' })
        continue
      }
      if (ignore && ignore(childRel, false)) {
        skipped.push({ relPath: childRel, reason: 'ignored' })
        continue
      }

      let info
      try {
        info = await stat(abs)
      } catch {
        skipped.push({ relPath: childRel, reason: 'unreadable' })
        continue
      }
      if (info.size > maxFileBytes) {
        skipped.push({ relPath: childRel, reason: 'too-large' })
        continue
      }
      if (totalBytes + info.size > maxTotalBytes) {
        truncated = true
        skipped.push({ relPath: childRel, reason: 'over-budget' })
        return
      }
      files.push({ abs, rel: childRel, bytes: info.size })
      totalBytes += info.size
    }
  }

  await visit(root, '')
  return { root, files, skipped, totalBytes, truncated }
}
