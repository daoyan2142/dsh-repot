/**
 * The folder set: a directory snapshot.
 *
 * A folder that contains `.git` is reported as `gitManaged` and marked
 * `selectable: false` — it belongs to the Git side, not to a file snapshot.
 * Two writers pointed at one tree is how histories get corrupted.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { walk } from './walk.js'

export async function scanFolder(absPath, limits = {}) {
  let gitManaged = false
  try {
    await stat(join(absPath, '.git'))
    gitManaged = true
  } catch {
    gitManaged = false
  }

  const maxFileMB = limits.maxFileMB ?? 10
  const maxSetMB = limits.maxSetMB ?? 500

  let walked
  try {
    walked = await walk(absPath, {
      maxFileBytes: maxFileMB * 1024 * 1024,
      maxTotalBytes: maxSetMB * 1024 * 1024,
    })
  } catch (error) {
    return {
      absPath,
      selectable: false,
      gitManaged,
      error: error?.message ?? String(error),
      bytes: 0,
      fileCount: 0,
      files: [],
      skipped: [],
      truncated: false,
    }
  }

  return {
    absPath,
    selectable: !gitManaged,
    gitManaged,
    bytes: walked.totalBytes,
    fileCount: walked.files.length,
    files: walked.files.map((f) => ({ relPath: f.rel, bytes: f.bytes })),
    skipped: walked.skipped,
    truncated: walked.truncated,
  }
}
