import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { isDriveRoot, isInside, isStrictlyInside, safeRelSegments } from '../lib/pathutil.js'
import {
  GuardError,
  assertRootsExist,
  assertWritable,
  inspectTarget,
  preflight,
  writeMarker,
} from '../lib/guard.js'

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'repot-guard-')))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  return { base, root, outside }
}

test('isDriveRoot only matches a bare drive', () => {
  assert.equal(isDriveRoot('C:\\'), true)
  assert.equal(isDriveRoot('C:'), true)
  assert.equal(isDriveRoot('C:/'), true)
  assert.equal(isDriveRoot('C:\\work'), false)
  assert.equal(isDriveRoot('/usr'), false)
})

test('isInside respects the separator boundary', () => {
  assert.equal(isInside('C:\\work\\a', 'C:\\work'), true)
  assert.equal(isInside('C:\\work', 'C:\\work'), true)
  assert.equal(isInside('C:\\workshop', 'C:\\work'), false)
  assert.equal(isStrictlyInside('C:\\work', 'C:\\work'), false)
})

test('safeRelSegments refuses traversal and drive-qualified input', () => {
  assert.deepEqual(safeRelSegments('a/b/c'), ['a', 'b', 'c'])
  assert.deepEqual(safeRelSegments('a\\b'), ['a', 'b'])
  assert.equal(safeRelSegments('../etc'), null)
  assert.equal(safeRelSegments('a/../../b'), null)
  assert.equal(safeRelSegments('C:/abs'), null)
})

test('assertWritable refuses paths outside every root', async () => {
  const { root, outside } = await sandbox()
  try {
    await assert.rejects(
      () => assertWritable(join(outside, 'x.txt'), [{ id: 'work', path: root }]),
      (e) => e instanceof GuardError && e.code === 'outside-roots',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('assertWritable refuses a missing root', async () => {
  const { root } = await sandbox()
  try {
    await assert.rejects(
      () => assertWritable(join(root, 'ghost', 'x.txt'), [{ id: 'work', path: join(root, 'ghost') }]),
      (e) => e instanceof GuardError && e.code === 'root-missing',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('assertWritable refuses a junction that leaves the root', async (t) => {
  const { root, outside } = await sandbox()
  try {
    const link = join(root, 'link')
    try {
      await symlink(outside, link, 'junction')
    } catch {
      t.skip('junction not permitted in this environment')
      return
    }
    await assert.rejects(
      () => assertWritable(join(link, 'x.txt'), [{ id: 'work', path: root }]),
      (e) => e instanceof GuardError && e.code === 'symlink-escape',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('assertRootsExist names the missing root', async () => {
  const { root } = await sandbox()
  try {
    await assertRootsExist([{ id: 'work', path: root }])
    await assert.rejects(
      () => assertRootsExist([{ id: 'ghost', path: join(root, 'nope') }]),
      (e) => e instanceof GuardError && e.code === 'root-missing',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('inspectTarget: absent, adopt our marker, refuse a foreign one', async () => {
  const { root } = await sandbox()
  try {
    const dir = join(root, 'folder')
    assert.equal((await inspectTarget(dir, 'f1')).status, 'absent')

    await mkdir(dir, { recursive: true })
    assert.equal((await inspectTarget(dir, 'f1')).status, 'conflict')

    await writeMarker(dir, { id: 'f1', sha256: 'x' })
    assert.equal((await inspectTarget(dir, 'f1')).status, 'adopt')
    assert.equal((await inspectTarget(dir, 'f2')).status, 'conflict')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preflight resolves levels 1, 2, 3 and flags the unmanaged target', async () => {
  const { base, root, outside } = await sandbox()
  try {
    const existing = join(root, 'preexisting')
    await mkdir(existing, { recursive: true })
    await writeFile(join(existing, 'a.txt'), 'x', 'utf8')

    const items = [
      // level 1: absPath exists
      { id: 'l1', absPath: join(root, 'preexisting'), rootId: 'work', relPath: 'preexisting' },
      // level 2: absPath gone, rootId+relPath resolves to an existing dir
      { id: 'l2', absPath: join(base, 'gone-everywhere'), rootId: 'work', relPath: 'preexisting' },
      // level 3: nothing there yet
      { id: 'l3', absPath: join(base, 'gone-too'), rootId: 'work', relPath: 'brand-new' },
      // unconfigured root
      { id: 'l4', absPath: join(base, 'nowhere'), rootId: 'other', relPath: 'x' },
      // traversal attempt
      { id: 'l5', absPath: join(base, 'nowhere2'), rootId: 'work', relPath: '../outside' },
    ]

    const results = await preflight(items, { roots: [{ id: 'work', path: root }] })
    const byId = Object.fromEntries(results.map((r) => [r.id, r]))

    assert.equal(byId.l1.level, 1)
    assert.equal(byId.l2.level, 2)
    assert.equal(byId.l3.level, 3)
    assert.equal(byId.l4.conflict, 'root-not-configured')
    assert.equal(byId.l5.conflict, 'bad-relative-path')

    // A pre-existing directory we did not create is never adopted silently.
    assert.equal(byId.l2.status, 'conflict')
    assert.equal(byId.l2.writable, false)
    assert.equal(byId.l3.writable, true)

    // A path that really exists outside the root is refused at level 1.
    // (A missing absPath is not an escape — it relocates via rootId + relPath,
    // which is exactly the cross-machine behaviour we want.)
    const escOutside = join(outside, 'o')
    await mkdir(escOutside, { recursive: true })
    const escaped = await preflight([{ id: 'x', absPath: escOutside, rootId: 'work', relPath: 'o' }], {
      roots: [{ id: 'work', path: root }],
    })
    assert.equal(escaped[0].level, 1)
    assert.equal(escaped[0].writable, false)
    assert.equal(escaped[0].conflict, 'outside-roots')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
