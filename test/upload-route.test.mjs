/**
 * End-to-end through the routes, with fetch stubbed: upload a config-only set
 * to a fake GitHub, then compare the same machine against the manifest that
 * upload produced. Proves the S10/S11 wiring, not just the units.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, mkdir, rm, realpath, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../index.js'
import { sha256, sha256OfFiles } from '../lib/manifest.js'

function makeReq(url, method, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    body: '',
    writableEnded: false,
    writeHead(status) {
      this.statusCode = status
    },
    end(body) {
      this.body = body
      this.writableEnded = true
    },
  }
}

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

async function mount(profile, seed = { REPOT_GITHUB_TOKEN: 'token' }) {
  const store = new Map(Object.entries(seed))
  const credentials = {
    describe: async (ref) => ({ configured: store.has(ref) }),
    resolve: async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined),
    set: async (ref, value) => store.set(ref, value),
    unset: async (ref) => store.delete(ref),
  }
  const routes = []
  const ctx = {
    fiber: {},
    get: (name) => (name === 'credentials' ? credentials : undefined),
    effect: (fn) => fn(),
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
  }
  process.env.DSH_PROFILE_DIR = profile
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 25))

  const registered = routes.find((r) => r.path === '/repot/api')
  assert.ok(registered)

  async function post(method, body) {
    const res = makeRes()
    await registered.handler(makeReq('/repot/api/' + method, 'POST', body), res)
    const payload = res.body ? JSON.parse(res.body) : null
    return { status: res.statusCode, ok: payload?.ok, value: payload?.value, error: payload?.error }
  }
  return { post }
}

test('upload then compare round-trips the config set through a fake GitHub', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-upload-')))
  let uploadedManifest

  const stub = stubFetch((method, url, body) => {
    if (method === 'GET' && url.endsWith('/git/ref/heads/main')) return { status: 404, body: { message: 'Not Found' } }
    if (method === 'POST' && url.endsWith('/git/trees')) {
      const entry = body.tree.find((e) => e.path === 'sync/manifest.json')
      if (entry?.content) uploadedManifest = JSON.parse(Buffer.from(entry.content, 'base64').toString('utf8'))
      return { status: 201, body: { sha: 'T1' } }
    }
    if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'C1' } }
    if (method === 'POST' && url.endsWith('/git/refs')) return { status: 201, body: {} }
    if (method === 'GET' && url.includes('/contents/sync/manifest.json')) {
      return {
        status: 200,
        body: {
          sha: 'blob-sha',
          content: Buffer.from(JSON.stringify(uploadedManifest)).toString('base64'),
        },
      }
    }
    return undefined
  })

  try {
    for (const [name, text] of [
      ['cordis.patch.yml', '- id: ui-theme\n'],
      ['package.json', '{"name":"p"}'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9'],
      ['pnpm-workspace.yaml', 'packages: []'],
      ['cordis.yml', '[]'],
    ]) {
      await writeFile(join(profile, name), text, 'utf8')
    }

    const { post } = await mount(profile)

    const settings = await post('settings', { platform: 'github', repo: 'o/r', branch: 'main', roots: [] })
    assert.equal(settings.status, 200)

    const upload = await post('upload', { sets: [] })
    assert.equal(upload.status, 200, JSON.stringify(upload.error))
    assert.equal(upload.value.commit, 'C1')
    assert.equal(upload.value.groups.length, 1, 'one target means one commit')
    assert.equal(upload.value.groups[0].strategy, 'trees')
    assert.equal(upload.value.groups[0].files, 4, 'three config files plus the manifest')
    assert.deepEqual(upload.value.groups[0].sets, ['config'])
    assert.equal(upload.value.groups[0].revision, 1, 'the first index in a repository is revision 1')

    assert.ok(uploadedManifest, 'the manifest rode the same commit')
    assert.equal(uploadedManifest.schemaVersion, 2)
    assert.equal(uploadedManifest.sets.config.items.length, 3)
    assert.ok(!uploadedManifest.sets.config.items.some((i) => i.relPath === 'cordis.yml'))

    const compare = await post('compare', {})
    assert.equal(compare.status, 200)
    assert.equal(compare.value.exists, true)
    assert.equal(compare.value.comparison.config.same.length, 3)
    assert.equal(compare.value.comparison.config.differ.length, 0)

    const history = await post('history', { limit: 10 })
    assert.equal(history.status, 200)
    assert.equal(history.value.entries.length, 1)
    const entry = history.value.entries[0]
    assert.equal(entry.kind, 'upload')
    assert.equal(entry.commit, 'C1')
    assert.equal(entry.totals.files, 4)
    assert.ok(entry.items.some((i) => i.path === 'config/package.json'))
    assert.ok(entry.items.some((i) => i.path === 'sync/manifest.json'))
  } finally {
    stub.restore()
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('sets with different targets commit to different repositories', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-two-')))
  const root = join(profile, 'work')
  await mkdir(join(root, 'notes'), { recursive: true })
  await writeFile(join(root, 'notes', 'a.txt'), 'hello', 'utf8')
  await writeFile(join(profile, 'package.json'), '{"name":"p"}', 'utf8')
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: x\n', 'utf8')

  const stub = stubFetch((method, url, body) => {
    const repo = url.includes('/repos/me/files-repo/') ? 'files' : url.includes('/repos/me/main-repo/') ? 'main' : null
    if (!repo) return undefined
    if (method === 'GET' && url.includes('/git/ref/heads/')) return { status: 404, body: { message: 'Not Found' } }
    if (method === 'POST' && url.endsWith('/git/trees')) return { status: 201, body: { sha: `T-${repo}` } }
    if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: `C-${repo}` } }
    if (method === 'POST' && url.endsWith('/git/refs')) return { status: 201, body: {} }
    if (method === 'POST' && url.endsWith('/git/blobs')) return { status: 201, body: { sha: `B-${repo}` } }
    return undefined
  })

  try {
    const { post } = await mount(profile, { REPOT_GITHUB_TOKEN: 'token' })

    const settings = await post('settings', {
      platform: 'github',
      repo: 'me/main-repo',
      branch: 'main',
      roots: [{ id: 'work', path: root }],
      targets: { files: { platform: 'github', repo: 'me/files-repo', branch: 'main' } },
    })
    assert.equal(settings.status, 200, JSON.stringify(settings.error))

    const upload = await post('upload', {
      config: ['package.json'],
      folders: [{ absPath: join(root, 'notes') }],
    })
    assert.equal(upload.status, 200, JSON.stringify(upload.error))
    assert.equal(upload.value.groups.length, 2, 'two repositories means two commits')

    const byRepo = Object.fromEntries(upload.value.groups.map((group) => [group.target.repo, group]))
    assert.deepEqual(byRepo['me/main-repo'].sets, ['config'])
    assert.deepEqual(byRepo['me/files-repo'].sets, ['files'])
    assert.equal(byRepo['me/main-repo'].commit, 'C-main')
    assert.equal(byRepo['me/files-repo'].commit, 'C-files')

    // Each manifest describes only the set that repository is responsible for.
    assert.equal(byRepo['me/main-repo'].manifest.sets.config.items.length, 1)
    assert.equal(byRepo['me/main-repo'].manifest.sets.files.items.length, 0)
    assert.equal(byRepo['me/files-repo'].manifest.sets.files.items.length, 1)
    assert.equal(byRepo['me/files-repo'].manifest.sets.config.items.length, 0)

    const history = await post('history', { limit: 10 })
    assert.equal(history.value.entries.length, 2, 'one log entry per repository')
    assert.deepEqual(
      history.value.entries.map((entry) => entry.repo).sort(),
      ['me/files-repo', 'me/main-repo'],
    )
  } finally {
    stub.restore()
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('a commit that carries one set keeps the others in the manifest', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-keep-')))
  let written
  let writtenBytes

  const previous = {
    schemaVersion: 2,
    tool: 'dsh-repot',
    generatedAt: '2026-11-01T00:00:00.000Z',
    revision: 7,
    platform: 'github',
    branch: 'main',
    sets: {
      plugins: { items: [{ name: 'dsh-boot-suite', version: '2.16.11', kind: 'registry', mode: 'registry', deps: [] }] },
      config: { items: [] },
      files: {
        items: [{ id: 'f1', absPath: 'D:\\work\\notes', rootId: 'work', relPath: 'notes', sha256: 'dead', fileCount: 2, bytes: 9 }],
      },
    },
  }

  const stub = stubFetch((method, url, body) => {
    if (method === 'GET' && url.endsWith('/git/ref/heads/main')) return { status: 200, body: { object: { sha: 'P1' } } }
    if (method === 'GET' && url.endsWith('/git/commits/P1')) return { status: 200, body: { tree: { sha: 'T0' } } }
    if (method === 'GET' && url.includes('/contents/sync/manifest.json')) {
      return { status: 200, body: { sha: 'blob', content: Buffer.from(JSON.stringify(previous)).toString('base64') } }
    }
    if (method === 'POST' && url.endsWith('/git/trees')) {
      const entry = body.tree.find((e) => e.path === 'sync/manifest.json')
      if (entry?.content) {
        writtenBytes = Buffer.from(entry.content, 'base64')
        written = JSON.parse(writtenBytes.toString('utf8'))
      }
      return { status: 201, body: { sha: 'T1' } }
    }
    if (method === 'POST' && url.endsWith('/git/commits')) return { status: 201, body: { sha: 'C2' } }
    if (method === 'PATCH' && url.endsWith('/git/refs/heads/main')) return { status: 200, body: {} }
    return undefined
  })

  try {
    for (const [name, text] of [
      ['cordis.patch.yml', '- id: ui-theme\n'],
      ['package.json', '{"name":"p"}'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9'],
      ['pnpm-workspace.yaml', 'packages: []'],
    ]) {
      await writeFile(join(profile, name), text, 'utf8')
    }

    const { post } = await mount(profile)
    await post('settings', { platform: 'github', repo: 'o/r', branch: 'main', roots: [] })

    const upload = await post('upload', { sets: [] })
    assert.equal(upload.status, 200, JSON.stringify(upload.error))
    assert.deepEqual(upload.value.groups[0].sets, ['config'])
    assert.deepEqual(upload.value.groups[0].preserved.sort(), ['files', 'plugins'])

    assert.equal(written.sets.config.items.length, 3, 'this commit owns the config set')
    assert.equal(written.sets.plugins.items.length, 1, 'an untouched set keeps its entry')
    assert.equal(written.sets.plugins.items[0].name, 'dsh-boot-suite')
    assert.equal(written.sets.files.items.length, 1, 'so does a folder the commit never mentioned')
    assert.equal(written.sets.files.items[0].id, 'f1')

    // A revision is a number you can hold two machines against.
    assert.equal(written.revision, 8, 'the index revision moves forward, it is not rewritten')
    assert.equal(upload.value.groups[0].revision, 8)
    assert.equal(upload.value.groups[0].indexSha, sha256(writtenBytes), 'the fingerprint covers the stored bytes')

    // Compare still sees the folders that this commit did not touch.
    const history = await post('history', { limit: 10 })
    assert.equal(history.value.entries[0].revision, 8)
    assert.equal(history.value.entries[0].indexSha, sha256(writtenBytes), 'the log can be checked against the repository')
    assert.deepEqual(history.value.entries[0].preserved.sort(), ['files', 'plugins'])
  } finally {
    stub.restore()
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('upload refuses without a configured repository', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-upload-')))
  try {
    const { post } = await mount(profile)
    const result = await post('upload', {})
    assert.equal(result.status, 400)
    assert.match(result.error.message, /repo is required/)
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('compare reports "no manifest yet" instead of failing', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-upload-')))
  const stub = stubFetch((method, url) => {
    if (method === 'GET' && url.includes('/contents/sync/manifest.json')) return { status: 404, body: { message: 'Not Found' } }
    return undefined
  })
  try {
    const { post } = await mount(profile)
    await post('settings', { platform: 'github', repo: 'o/r', branch: 'main', roots: [] })
    const compare = await post('compare', {})
    assert.equal(compare.status, 200)
    assert.equal(compare.value.exists, false)
  } finally {
    stub.restore()
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('apply refuses to run without an explicit confirmation', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-upload-')))
  try {
    const { post } = await mount(profile)
    await post('settings', { platform: 'github', repo: 'o/r', branch: 'main', roots: [] })
    const result = await post('apply', { folders: ['f1'] })
    assert.equal(result.status, 400)
    assert.equal(result.error.code, 'confirm-required')
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('apply reports a missing remote manifest instead of writing anything', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-upload-')))
  const stub = stubFetch((method, url) => {
    if (method === 'GET' && url.includes('/contents/sync/manifest.json')) return { status: 404, body: { message: 'Not Found' } }
    return undefined
  })
  try {
    const { post } = await mount(profile)
    await post('settings', { platform: 'github', repo: 'o/r', branch: 'main', roots: [] })
    const result = await post('apply', { confirm: true, folders: ['f1'] })
    assert.equal(result.status, 400)
    assert.match(result.error.message, /远端还没有清单/)
  } finally {
    stub.restore()
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('apply restores a folder through the route, index and all', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-upload-')))
  const root = join(profile, 'work')
  await mkdir(root, { recursive: true })

  const fileContent = Buffer.from('hello from the other machine')
  // The folder's own location is `notes` (relPath below), so its snapshot
  // paths are relative to the folder itself: `files/f1/a.txt`.
  const digest = sha256OfFiles([{ path: 'files/f1/a.txt', content: fileContent }])
  const manifest = {
    schemaVersion: 2,
    tool: 'dsh-repot',
    generatedAt: '2026-11-10T00:00:00.000Z',
    platform: 'github',
    branch: 'main',
    sets: {
      plugins: { items: [] },
      config: { items: [] },
      files: {
        items: [{ id: 'f1', absPath: null, rootId: 'work', relPath: 'notes', sha256: digest, fileCount: 1, bytes: fileContent.length }],
      },
    },
  }
  const contents = (text) => ({ status: 200, body: { sha: 's', content: Buffer.from(text).toString('base64') } })

  const stub = stubFetch((method, url) => {
    if (method !== 'GET') return undefined
    if (url.includes('/contents/sync/manifest.json')) return contents(JSON.stringify(manifest))
    if (url.includes('/contents/files/f1/.repot-index.json')) {
      return contents(
        JSON.stringify({
          id: 'f1',
          sha256: digest,
          files: [{ relPath: 'a.txt', bytes: fileContent.length, sha256: sha256(fileContent) }],
        }),
      )
    }
    if (url.includes('/contents/files/f1/a.txt')) return contents(fileContent)
    return undefined
  })

  try {
    const { post } = await mount(profile)
    const settings = await post('settings', { platform: 'github', repo: 'o/r', branch: 'main', roots: [{ id: 'work', path: root }] })
    assert.equal(settings.status, 200, JSON.stringify(settings.error))

    const result = await post('apply', { confirm: true, folders: ['f1'] })
    assert.equal(result.status, 200, JSON.stringify(result.error))

    const folder = result.value.folders[0]
    assert.equal(folder.status, 'applied')
    assert.equal(folder.level, 3, 'nothing was there before, so it was a level-3 create')
    assert.equal(await readFile(join(root, 'notes', 'a.txt'), 'utf8'), 'hello from the other machine')

    const marker = JSON.parse(await readFile(join(root, 'notes', '.repot.json'), 'utf8'))
    assert.equal(marker.id, 'f1')

    // Right after a restore the folder is the remote folder, and comparison says
    // so instead of the old "everything is always different".
    const hashes = { folders: [{ absPath: join(root, 'notes'), id: 'f1' }] }
    const same = await post('compare', hashes)
    assert.equal(same.value.comparison.files.same.length, 1)
    assert.equal(same.value.comparison.files.differ.length, 0)

    // One local edit later, the diff names the file — not just the folder.
    await writeFile(join(root, 'notes', 'a.txt'), 'edited on this machine', 'utf8')
    const differ = await post('compare', hashes)
    assert.equal(differ.value.comparison.files.differ.length, 1)
    assert.equal(differ.value.comparison.files.differ[0].diff.changed[0].relPath, 'a.txt')
  } finally {
    stub.restore()
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})
