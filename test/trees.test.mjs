import { test } from 'node:test'
import assert from 'node:assert/strict'

import { commitFilesGitHub } from '../lib/remote/trees.js'
import { uploadStrategyFor } from '../lib/remote/upload.js'

/** Replace global fetch with a router, recording every call. */
function stubFetch(route) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    const body = init.body ? JSON.parse(init.body) : undefined
    const call = { method, url: String(url), body }
    calls.push(call)
    const reply = route(method, call.url, body)
    if (!reply) throw new Error(`unexpected request: ${method} ${url}`)
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      async text() {
        return reply.body === undefined ? '' : JSON.stringify(reply.body)
      },
    }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

const SMALL = { path: 'sync/manifest.json', content: Buffer.from('{"a":1}') }
const BIG = { path: 'sync/packages/big.tgz', content: Buffer.alloc(2 * 1024 * 1024, 7) }

test('existing branch: one commit, delta tree, non-forced ref move', async () => {
  const stub = stubFetch((method, url) => {
    if (method === 'GET' && url.endsWith('/git/ref/heads/main')) return { status: 200, body: { object: { sha: 'P1' } } }
    if (method === 'GET' && url.endsWith('/git/commits/P1')) return { status: 200, body: { tree: { sha: 'T0' } } }
    if (method === 'POST' && url.endsWith('/git/blobs')) return { status: 201, body: { sha: 'B1' } }
    if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'T1' } }
    if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'C1' } }
    if (method === 'PATCH' && url.endsWith('/git/refs/heads/main')) return { status: 200, body: { object: { sha: 'C1' } } }
    return undefined
  })
  try {
    const result = await commitFilesGitHub({
      repo: 'o/r',
      token: 't',
      branch: 'main',
      files: [SMALL, BIG],
      message: 'repot: sync',
    })

    assert.equal(result.commit, 'C1')
    assert.equal(result.createdBranch, false)

    // Exactly one commit for the whole set.
    assert.equal(stub.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/git/commits')).length, 1)

    // The big file went through the blobs endpoint, the small one inline.
    const blobs = stub.calls.filter((c) => c.url.endsWith('/git/blobs'))
    assert.equal(blobs.length, 1)
    assert.equal(Buffer.from(blobs[0].body.content, 'base64').length, BIG.content.length)

    const firstTree = stub.calls.find((c) => c.url.endsWith('/git/trees'))
    assert.equal(firstTree.body.base_tree, 'T0', 'the tree is a delta over the existing one')
    assert.ok(firstTree.body.tree.some((e) => e.path === SMALL.path && e.content))

    // The blob sha is attached in a follow-up tree request.
    assert.ok(
      stub.calls.some(
        (c) => c.url.endsWith('/git/trees') && c.body.tree.some((e) => e.path === BIG.path && e.sha === 'B1'),
      ),
    )

    const commit = stub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))
    assert.deepEqual(commit.body.parents, ['P1'])

    const moved = stub.calls.find((c) => c.method === 'PATCH')
    assert.equal(moved.body.sha, 'C1')
    assert.equal(moved.body.force, false)
  } finally {
    stub.restore()
  }
})

test('missing branch: a parentless commit and a new ref', async () => {
  const stub = stubFetch((method, url) => {
    if (method === 'GET' && url.includes('/git/ref/heads/')) return { status: 404, body: { message: 'Not Found' } }
    if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'T1' } }
    if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'C1' } }
    if (method === 'POST' && url.endsWith('/git/refs')) return { status: 201, body: { ref: 'refs/heads/main' } }
    return undefined
  })
  try {
    const result = await commitFilesGitHub({ repo: 'o/r', token: 't', branch: 'main', files: [SMALL] })
    assert.equal(result.createdBranch, true)

    const commit = stub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/commits'))
    assert.deepEqual(commit.body.parents, [], 'a first commit has no parent')

    const created = stub.calls.find((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))
    assert.equal(created.body.sha, 'C1')
    assert.equal(created.body.ref, 'refs/heads/main')

    assert.equal(stub.calls.filter((c) => c.method === 'PATCH').length, 0)
  } finally {
    stub.restore()
  }
})

test('a moved remote branch is refused, never force-pushed', async () => {
  const stub = stubFetch((method, url) => {
    if (method === 'GET' && url.endsWith('/git/ref/heads/main')) return { status: 200, body: { object: { sha: 'P1' } } }
    if (method === 'GET' && url.endsWith('/git/commits/P1')) return { status: 200, body: { tree: { sha: 'T0' } } }
    if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'T1' } }
    if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'C1' } }
    if (method === 'PATCH' && url.endsWith('/git/refs/heads/main')) return { status: 422, body: { message: 'Update is not a fast forward' } }
    return undefined
  })
  try {
    await assert.rejects(
      () => commitFilesGitHub({ repo: 'o/r', token: 't', branch: 'main', files: [SMALL] }),
      /远端分支已前进/,
    )
  } finally {
    stub.restore()
  }
})

test('deletions become sha:null tree entries in the same commit', async () => {
  const stub = stubFetch((method, url) => {
    if (method === 'GET' && url.endsWith('/git/ref/heads/main')) return { status: 200, body: { object: { sha: 'P1' } } }
    if (method === 'GET' && url.endsWith('/git/commits/P1')) return { status: 200, body: { tree: { sha: 'T0' } } }
    if (method === 'POST' && url.endsWith('/git/blobs')) return { status: 201, body: { sha: 'B1' } }
    if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: 'T1' } }
    if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'C1' } }
    if (method === 'PATCH' && url.endsWith('/git/refs/heads/main')) return { status: 200, body: {} }
    return undefined
  })
  try {
    const result = await commitFilesGitHub({
      repo: 'o/r',
      token: 't',
      branch: 'main',
      files: [SMALL, BIG],
      deletions: ['sync/packages/old.tgz'],
    })
    assert.equal(result.deletions, 1)
    const removal = stub.calls
      .filter((c) => c.url.endsWith('/git/trees'))
      .flatMap((c) => c.body.tree)
      .find((e) => e.path === 'sync/packages/old.tgz')
    assert.ok(removal, 'the deletion rides the tree')
    assert.equal(removal.sha, null)
  } finally {
    stub.restore()
  }
})

test('gitee takes the contents strategy, github the tree strategy', () => {
  assert.equal(uploadStrategyFor('github'), 'trees')
  assert.equal(uploadStrategyFor('gitee'), 'contents')
})
