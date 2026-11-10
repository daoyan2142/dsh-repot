import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { diffFolder, hashFolder, indexFiles } from '../lib/dirdiff.js'
import { collectPayload } from '../lib/collect.js'

async function tmp(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

test('hashFolder produces the same digest the uploader computes', async () => {
  const dir = await tmp('repot-dir-')
  try {
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'A', 'utf8')
    await writeFile(join(dir, 'sub', 'b.txt'), 'B', 'utf8')

    const hashed = await hashFolder({ id: 'f1', absPath: dir })
    const payload = await collectPayload({ folders: [{ id: 'f1', absPath: dir, rootId: 'work', relPath: 'notes' }] })

    assert.equal(hashed.fileCount, 2)
    assert.equal(hashed.sha256, payload.folders[0].sha256, 'local hash and upload digest are one number')
    assert.deepEqual(
      hashed.files.map((f) => f.relPath).sort(),
      ['a.txt', 'sub/b.txt'],
      'relative paths keep the folder-relative shape',
    )

    const index = JSON.parse(payload.uploads.find((u) => u.path.endsWith('.repot-index.json')).content.toString('utf8'))
    assert.ok(index.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), 'every index entry carries its own hash')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('diffFolder names the files that changed, appeared or vanished', () => {
  const remote = [
    { relPath: 'keep.md', bytes: 1, sha256: 'a' },
    { relPath: 'edit.md', bytes: 2, sha256: 'b' },
    { relPath: 'new.md', bytes: 3, sha256: 'c' },
  ]
  const local = [
    { relPath: 'keep.md', bytes: 1, sha256: 'a' },
    { relPath: 'edit.md', bytes: 9, sha256: 'z' },
    { relPath: 'gone.md', bytes: 4, sha256: 'd' },
  ]

  const diff = diffFolder(remote, local)
  assert.equal(diff.supported, true)
  assert.deepEqual(diff.added.map((f) => f.relPath), ['new.md'])
  assert.deepEqual(diff.changed.map((f) => f.relPath), ['edit.md'])
  assert.deepEqual(diff.removed.map((f) => f.relPath), ['gone.md'])
  assert.deepEqual(diff.counts, { added: 1, changed: 1, removed: 1 })
})

test('diffFolder admits when an old index cannot be compared file by file', () => {
  const diff = diffFolder([{ relPath: 'a.txt', bytes: 1 }], [{ relPath: 'a.txt', bytes: 1, sha256: 'a' }])
  assert.equal(diff.supported, false)
  assert.deepEqual(diff.counts, { added: 0, changed: 0, removed: 0 })
})

test('indexFiles tolerates an index without hashes', () => {
  assert.deepEqual(indexFiles({ files: [{ relPath: 'a.txt', bytes: 2 }] }), [{ relPath: 'a.txt', bytes: 2 }])
})
