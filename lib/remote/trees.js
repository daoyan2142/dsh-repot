/**
 * GitHub Git Data API: many files, one commit.
 *
 * The sequence is fixed:
 *   read ref → read parent commit → (blobs for big files) → create tree →
 *   create commit → move the ref
 *
 * Creating the tree with `base_tree` makes the new tree a delta over the
 * existing one, so files that are not part of this upload stay untouched —
 * uploading a folder never deletes the repository's other content.
 */
import { splitRepo } from '../git.js'
import { splitForUpload } from './plan.js'

function encodeRefPath(branch) {
  return String(branch)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export async function commitFilesGitHub({
  base = 'https://api.github.com',
  repo,
  token,
  branch,
  files = [],
  deletions = [],
  message,
  fetchImpl = globalThis.fetch,
}) {
  const { owner, name } = splitRepo(repo)
  const root = `${base}/repos/${owner}/${name}`
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'content-type': 'application/json',
  }

  async function call(method, path, body) {
    const res = await fetchImpl(root + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, ok: res.ok, json, text }
  }

  // 1. Current tip, if the branch exists at all.
  const ref = await call('GET', `/git/ref/heads/${encodeRefPath(branch)}`)
  let parentCommit
  let baseTree
  if (ref.ok && ref.json?.object?.sha) {
    parentCommit = ref.json.object.sha
    const parent = await call('GET', `/git/commits/${parentCommit}`)
    if (!parent.ok) throw new Error(`读取父提交失败：HTTP ${parent.status}`)
    baseTree = parent.json?.tree?.sha
    if (!baseTree) throw new Error('父提交里没有 tree')
  } else if (ref.status !== 404) {
    throw new Error(`读取分支失败：HTTP ${ref.status}${ref.json?.message ? ' — ' + ref.json.message : ''}`)
  }

  // 2. Plan and push blobs.
  const plan = splitForUpload(files, { deletions })
  const blobShas = new Map()
  for (const blob of plan.blobs) {
    const created = await call('POST', '/git/blobs', {
      content: blob.content.toString('base64'),
      encoding: 'base64',
    })
    if (!created.ok) throw new Error(`创建 blob 失败（${blob.path}）：HTTP ${created.status}`)
    blobShas.set(blob.path, created.json.sha)
  }

  // 3. One tree per batch, chained so each builds on the previous result.
  let treeSha = baseTree
  let treeEntries = 0

  for (const batch of plan.batches) {
    const entries = batch.entries.map((entry) => ({
      path: entry.path,
      mode: '100644',
      type: 'blob',
      content: entry.content.toString('base64'),
    }))
    const created = await call('POST', '/git/trees', {
      ...(treeSha ? { base_tree: treeSha } : {}),
      tree: entries,
    })
    if (!created.ok) throw new Error(`创建 tree 失败：HTTP ${created.status}${created.json?.message ? ' — ' + created.json.message : ''}`)
    treeSha = created.json.sha
    treeEntries += entries.length
  }

  // 4. Entries that need a blob sha, plus removals.
  const extras = [
    ...[...blobShas.entries()].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })),
    ...plan.deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
  ]
  if (extras.length) {
    const created = await call('POST', '/git/trees', {
      ...(treeSha ? { base_tree: treeSha } : {}),
      tree: extras,
    })
    if (!created.ok) throw new Error(`创建 tree 失败：HTTP ${created.status}`)
    treeSha = created.json.sha
    treeEntries += extras.length
  }

  if (!treeSha) throw new Error('没有任何内容可提交')

  // 5. Exactly one commit for the whole batch.
  const commit = await call('POST', '/git/commits', {
    message: message ?? `repot: sync ${treeEntries} files`,
    tree: treeSha,
    parents: parentCommit ? [parentCommit] : [],
  })
  if (!commit.ok) throw new Error(`创建提交失败：HTTP ${commit.status}${commit.json?.message ? ' — ' + commit.json.message : ''}`)
  const commitSha = commit.json.sha

  // 6. Move the branch. Never force: a concurrent push must fail loudly.
  if (parentCommit) {
    const moved = await call('PATCH', `/git/refs/heads/${encodeRefPath(branch)}`, { sha: commitSha, force: false })
    if (!moved.ok) {
      throw new Error(
        moved.status === 422 || moved.status === 409
          ? '远端分支已前进，请先拉取对比再上传'
          : `更新分支失败：HTTP ${moved.status}`,
      )
    }
  } else {
    const created = await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commitSha })
    if (!created.ok) throw new Error(`创建分支失败：HTTP ${created.status}`)
  }

  return {
    commit: commitSha,
    createdBranch: !parentCommit,
    entries: treeEntries,
    files: files.length,
    deletions: plan.deletions.length,
    bytes: planBytes(plan),
  }
}

/** Bytes moved by a plan (kept local to avoid a circular import). */
function planBytes(plan) {
  return (
    plan.blobs.reduce((sum, b) => sum + b.bytes, 0) +
    plan.batches.reduce((sum, batch) => sum + batch.bytes, 0)
  )
}
