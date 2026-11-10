/**
 * Integration test for the Host half: mounts the real `apply()` against a fake
 * Cordis context and drives the real HTTP handler with fake req/res objects.
 * No DSH process, no restart.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../index.js'

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
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(body) {
      this.body = body
      this.writableEnded = true
    },
  }
}

/** Mount the plugin and return a request helper. */
async function mount({ profile, rejection, store = new Map() } = {}) {
  const credentials = {
    describe: async (ref) => ({ configured: store.has(ref) }),
    resolve: async (ref) => (store.has(ref) ? { value: store.get(ref) } : undefined),
    set: async (ref, value) => {
      store.set(ref, value)
    },
    unset: async (ref) => {
      store.delete(ref)
    },
  }

  const routes = []
  const ctx = {
    fiber: {},
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'settings') return undefined
      if (name === 'pluginManager') return undefined
      return undefined
    },
    effect(fn) {
      return fn()
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: {
      requestRejection: () => rejection,
    },
  }

  if (profile) process.env.DSH_PROFILE_DIR = profile
  apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 30)) // let migrateTokens settle

  const registered = routes.find((r) => r.path === '/repot/api')
  assert.ok(registered, 'apply() must register the /repot/api prefix route')

  async function post(method, body) {
    const res = makeRes()
    await registered.handler(makeReq('/repot/api/' + method, 'POST', body), res)
    const payload = res.body ? JSON.parse(res.body) : null
    return { status: res.statusCode, ok: payload?.ok, value: payload?.value, error: payload?.error }
  }

  async function request(method, url) {
    const res = makeRes()
    await registered.handler(makeReq(url, method), res)
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
  }

  return { post, request, store }
}

test('router: guards method, path and connection rejection', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-router-')))
  try {
    const { request } = await mount({ profile })

    assert.equal((await request('GET', '/repot/api/state')).status, 405)

    const unknown = await request('POST', '/repot/api/nope')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'not-found')

    const blocked = await mount({ profile, rejection: 'cross-origin' })
    const forbidden = await blocked.request('POST', '/repot/api/state')
    assert.equal(forbidden.status, 403)
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('state reports a migrated v1 document and keeps the repository', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-router-')))
  try {
    await mkdir(join(profile, '.git-sync'), { recursive: true })
    await writeFile(
      join(profile, '.git-sync', 'settings.json'),
      JSON.stringify({
        platform: 'gitee',
        profiles: { github: { repo: '', branch: 'main' }, gitee: { repo: 'o/r', branch: 'trunk' } },
      }),
      'utf8',
    )

    const { post } = await mount({ profile })
    const state = await post('state')
    assert.equal(state.status, 200)
    assert.equal(state.value.platform, 'gitee')
    assert.equal(state.value.repo, 'o/r')
    assert.equal(state.value.branch, 'trunk')
    assert.equal(state.value.migrated, true)
    assert.deepEqual(state.value.roots, [])
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('legacy PAT is copied to the new ref exactly once', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-router-')))
  try {
    const { post, store } = await mount({ profile })
    assert.equal(store.has('REPOT_GITEE_TOKEN'), false)

    // Seed as if the old plugin had stored a token, then re-mount on the same
    // credentials store (a fresh Map would defeat the point of the test).
    store.set('GIT_SYNC_GITEE_TOKEN', 'legacy-token')
    const second = await mount({ profile, store })
    assert.equal(second.store.get('REPOT_GITEE_TOKEN'), 'legacy-token')
    assert.equal(second.store.get('GIT_SYNC_GITEE_TOKEN'), 'legacy-token', 'legacy ref is left intact')

    const state = await post('state')
    assert.equal(state.value.tokens.gitee, true)
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('settings rejects a drive root and a missing root', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-router-')))
  try {
    const { post } = await mount({ profile })

    const driveRoot = await post('settings', { roots: [{ id: 'c', path: 'C:\\' }] })
    assert.equal(driveRoot.status, 400)
    assert.equal(driveRoot.error.code, 'invalid-roots')

    const missing = await post('settings', { roots: [{ id: 'work', path: join(profile, 'ghost') }] })
    assert.equal(missing.status, 400)
    assert.equal(missing.error.code, 'root-missing')

    const ok = await post('settings', { roots: [{ id: 'work', path: profile }] })
    assert.equal(ok.status, 200)
    assert.equal(ok.value.roots.length, 1)
    assert.equal(ok.value.roots[0].id, 'work')
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})

test('preflight needs roots, then resolves a real item through the route', async () => {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'repot-router-')))
  try {
    const { post } = await mount({ profile })

    const noRoots = await post('preflight', { items: [] })
    assert.equal(noRoots.status, 400)
    assert.equal(noRoots.error.code, 'no-roots')

    await post('settings', { roots: [{ id: 'work', path: profile }] })
    await mkdir(join(profile, 'notes'), { recursive: true })

    const result = await post('preflight', {
      items: [
        { id: 'f1', absPath: join(profile, 'notes'), rootId: 'work', relPath: 'notes' },
        { id: 'f2', absPath: join(profile, 'nope'), rootId: 'work', relPath: 'fresh' },
      ],
    })
    assert.equal(result.status, 200)
    const [f1, f2] = result.value.results
    assert.equal(f1.level, 1)
    assert.equal(f1.status, 'conflict', 'a directory we did not create is not adopted')
    assert.equal(f2.level, 3)
    assert.equal(f2.writable, true)
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})
