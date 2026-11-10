import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compareConfig, compareFiles, comparePlugins, summarize } from '../lib/compare.js'
import { buildManifest, sha256OfFiles } from '../lib/manifest.js'

test('comparePlugins classifies by name, version and install shape', () => {
  const remote = [
    { name: 'new-one', version: '1.0.0', kind: 'registry', mode: 'registry' },
    { name: 'same-one', version: '2.0.0', kind: 'registry' },
    { name: 'old-one', version: '3.0.0', kind: 'registry' },
    { name: 'kind-one', version: '1.0.0', kind: 'source' },
  ]
  const local = [
    { name: 'same-one', version: '2.0.0', kind: 'registry' },
    { name: 'old-one', version: '1.0.0', kind: 'registry' },
    { name: 'kind-one', version: '1.0.0', kind: 'registry' },
    { name: 'local-only', version: '9.9.9', kind: 'registry' },
  ]
  const result = comparePlugins(remote, local)

  assert.deepEqual(result.install.map((i) => i.name), ['new-one'])
  assert.deepEqual(result.same.map((i) => i.name), ['same-one'])
  assert.deepEqual(result.differ.map((i) => i.name), ['old-one', 'kind-one'])
  assert.equal(result.differ[0].reason, 'version')
  assert.equal(result.differ[1].reason, 'kind')
  assert.deepEqual(result.extraLocal.map((i) => i.name), ['local-only'])
})

test('compareConfig compares hashes and reports both directions', () => {
  const remote = [
    { relPath: 'package.json', sha256: 'aaaa1111' },
    { relPath: 'cordis.patch.yml', sha256: 'bbbb2222' },
    { relPath: 'pnpm-lock.yaml', sha256: 'cccc3333' },
  ]
  const local = [
    { relPath: 'package.json', sha256: 'aaaa1111' },
    { relPath: 'cordis.patch.yml', sha256: 'ffff9999' },
    { relPath: 'extra.yml', sha256: 'dddd4444', bytes: 10 },
  ]
  const result = compareConfig(remote, local)

  assert.deepEqual(result.same.map((i) => i.relPath), ['package.json'])
  assert.deepEqual(result.differ.map((i) => i.relPath), ['cordis.patch.yml'])
  assert.deepEqual(result.missingLocal.map((i) => i.relPath), ['pnpm-lock.yaml'])
  assert.deepEqual(result.extraLocal.map((i) => i.relPath), ['extra.yml'])
})

test('compareConfig marks an unhashable local file instead of guessing', () => {
  const result = compareConfig([{ relPath: 'package.json', sha256: 'a' }], [{ relPath: 'package.json' }])
  assert.equal(result.differ.length, 1)
  assert.equal(result.differ[0].reason, 'no-hash')
})

test('compareFiles reports folders this machine has never seen', () => {
  const remote = [
    { id: 'f1', sha256: 'h1', rootId: 'work', relPath: 'notes' },
    { id: 'f2', sha256: 'h2', rootId: 'work', relPath: 'assets' },
  ]
  const local = [{ id: 'f1', sha256: 'h1' }]
  const result = compareFiles(remote, local)

  assert.deepEqual(result.same.map((i) => i.id), ['f1'])
  assert.deepEqual(result.unknown.map((i) => i.id), ['f2'])
  assert.equal(result.unknown[0].rootId, 'work')
  assert.equal(result.unknown[0].relPath, 'assets')
})

test('summarize mentions only the non-empty buckets', () => {
  const text = summarize({
    plugins: { install: [{}, {}], same: [{}], differ: [], extraLocal: [] },
    config: { same: [{}], differ: [], missingLocal: [] },
  })
  assert.match(text, /plugins: install 2 · same 1/)
  assert.match(text, /config: same 1/)
  assert.ok(!text.includes('files'))
})

test('buildManifest defaults registry items to reinstall mode', () => {
  const manifest = buildManifest({
    platform: 'github',
    branch: 'main',
    plugins: [
      { name: 'a', version: '1.0.0', kind: 'registry' },
      { name: 'b', version: '2.0.0', kind: 'source', dir: 'plugins/b', sha256: 'x' },
    ],
    config: [{ relPath: 'package.json', sha256: 'h', bytes: 10 }],
    files: [{ id: 'f1', rootId: 'work', relPath: 'notes', sha256: 'y', fileCount: 3, bytes: 99 }],
  })
  assert.equal(manifest.schemaVersion, 2)
  assert.equal(manifest.sets.plugins.items[0].mode, 'registry')
  assert.equal(manifest.sets.plugins.items[1].mode, 'carry')
  assert.equal(manifest.sets.files.items[0].relPath, 'notes')
})

test('sha256OfFiles is order-independent and content-sensitive', () => {
  const a = [
    { path: 'b.txt', content: Buffer.from('2') },
    { path: 'a.txt', content: Buffer.from('1') },
  ]
  const b = [
    { path: 'a.txt', content: Buffer.from('1') },
    { path: 'b.txt', content: Buffer.from('2') },
  ]
  const c = [
    { path: 'a.txt', content: Buffer.from('1') },
    { path: 'b.txt', content: Buffer.from('3') },
  ]
  assert.equal(sha256OfFiles(a), sha256OfFiles(b))
  assert.notEqual(sha256OfFiles(a), sha256OfFiles(c))
})
