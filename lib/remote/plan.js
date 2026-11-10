/**
 * Pure upload planning. Decides, for a set of files, which ones ride inline in
 * a tree request and how the rest are batched — no network, no filesystem, so
 * the decisions can be tested exactly.
 *
 * GitHub's create-tree call accepts inline base64 `content` per entry, which
 * collapses an N-file upload into one commit. The catch is request size, so
 * small files ride inline in payload-sized batches and big ones go through the
 * blobs endpoint first.
 */

export const INLINE_MAX_BYTES = 1024 * 1024
export const BATCH_MAX_BYTES = 4 * 1024 * 1024

/**
 * @param {Array<{path: string, content: Buffer, bytes?: number}>} files
 * @param {object} [options]
 * @param {string[]} [options.deletions] paths to remove in the same commit
 * @returns {{blobs: Array, batches: Array<{entries: Array, bytes: number}>, deletions: string[]}}
 */
export function splitForUpload(files, options = {}) {
  const inlineMax = options.inlineMaxBytes ?? INLINE_MAX_BYTES
  const batchMax = options.batchMaxBytes ?? BATCH_MAX_BYTES

  const blobs = []
  const batches = []
  const deletions = Array.isArray(options.deletions) ? [...options.deletions] : []

  let current = { entries: [], bytes: 0 }

  for (const file of files ?? []) {
    const bytes = file.bytes ?? file.content?.length ?? 0
    if (bytes > inlineMax) {
      blobs.push({ path: file.path, content: file.content, bytes })
      continue
    }
    if (current.entries.length && current.bytes + bytes > batchMax) {
      batches.push(current)
      current = { entries: [], bytes: 0 }
    }
    current.entries.push({ path: file.path, content: file.content, bytes, inline: true })
    current.bytes += bytes
  }
  if (current.entries.length) batches.push(current)

  return { blobs, batches, deletions }
}

/** Total bytes a plan will move. */
export function planBytes(plan) {
  const blobBytes = plan.blobs.reduce((sum, b) => sum + b.bytes, 0)
  const inlineBytes = plan.batches.reduce((sum, batch) => sum + batch.bytes, 0)
  return blobBytes + inlineBytes
}

/** Reject an upload that is obviously too large before any request is made. */
export function assertPlanWithinLimits(plan, limits = {}) {
  const maxFiles = limits.maxUploadFiles ?? 300
  const maxBytes = (limits.maxUploadMB ?? 50) * 1024 * 1024
  const fileCount = plan.blobs.length + plan.batches.reduce((sum, batch) => sum + batch.entries.length, 0)
  const bytes = planBytes(plan)
  if (fileCount > maxFiles) {
    throw new Error(`文件数 ${fileCount} 超过上限 ${maxFiles}；请减少文件夹或拆分上传`)
  }
  if (bytes > maxBytes) {
    throw new Error(`上传体积 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过上限 ${limits.maxUploadMB ?? 50}MB`)
  }
  return { fileCount, bytes }
}
