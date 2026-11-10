/**
 * Upload dispatcher.
 *
 * GitHub gets the Git Data API (one commit for the whole set). Gitee's tree
 * endpoint is not dependable across versions, so it takes the Contents API
 * path: one request per file. That is slower but it always lands, and the
 * caller is told which mode ran.
 */
import { putFile } from '../git.js'
import { commitFilesGitHub } from './trees.js'

export function uploadStrategyFor(platform) {
  return platform === 'github' ? 'trees' : 'contents'
}

export async function uploadFiles({
  platform,
  repo,
  token,
  branch,
  files = [],
  deletions = [],
  message,
  fetchImpl,
}) {
  if (platform === 'github') {
    const result = await commitFilesGitHub({ repo, token, branch, files, deletions, message, fetchImpl })
    return { strategy: 'trees', ...result }
  }

  let written = 0
  let bytes = 0
  for (const file of files) {
    await putFile({
      platform,
      repo,
      branch,
      token,
      path: file.path,
      contentBase64: file.content.toString('base64'),
      message: `${message ?? 'repot: sync'} — ${file.path}`,
    })
    written += 1
    bytes += file.bytes ?? file.content.length
  }

  return {
    strategy: 'contents',
    commit: null,
    entries: written,
    files: files.length,
    // The Contents API cannot express a deletion in the same pass; surface it
    // instead of silently leaving remote files behind.
    deletions: 0,
    refusedDeletions: deletions,
    bytes,
  }
}
