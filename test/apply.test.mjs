import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { applyFolder } from '../lib/apply/files.js'
import { applyConfig, rewriteFileSpecs } from '../lib/apply/config.js'
import { applyPlugins } from '../lib/apply/plugins.js'
import { sha256OfFiles } from '../lib/manifest.js'

async function tmp(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

const f = (path, text) => ({ path, content: Buffer.from(text) })

function folderSha(id, files) {
  return sha256OfFiles(files.filter((file) => !file.path.endsWith('.repot-index.json')))
}

test('applyFolder writes the snapshot and stamps it', async () => {
  const root = await tmp('repot-apply-')
  try {
    const files = [f('files/f1/a.txt', 'A'), f('files/f1/sub/b.txt', 'B'), f('files/f1/.repot-index.json', '{}')]
    const item = { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', files) }

    const result = await applyFolder({ item, roots: [{ id: 'work', path: root }], files })
    assert.equal(result.status, 'applied')
    assert.equal(result.level, 3)
    assert.equal(result.written, 2)
    assert.equal(await readFile(join(root, 'notes', 'a.txt'), 'utf8'), 'A')
    assert.equal(await readFile(join(root, 'notes', 'sub', 'b.txt'), 'utf8'), 'B')

    const marker = JSON.parse(await readFile(join(root, 'notes', '.repot.json'), 'utf8'))
    assert.deepEqual(marker.files.sort(), ['a.txt', 'sub/b.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFolder prunes only what it wrote last time', async () => {
  const root = await tmp('repot-apply-')
  try {
    const roots = [{ id: 'work', path: root }]
    const first = [f('files/f1/a.txt', 'A'), f('files/f1/b.txt', 'B')]
    await applyFolder({ item: { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', first) }, roots, files: first })

    // A file the user added by hand must survive the next restore.
    await writeFile(join(root, 'notes', 'mine.txt'), 'mine', 'utf8')

    const second = [f('files/f1/a.txt', 'A')]
    const result = await applyFolder({
      item: { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', second) },
      roots,
      files: second,
    })

    assert.equal(result.status, 'applied')
    assert.equal(result.removed, 1, 'the dropped file is removed')
    await assert.rejects(() => stat(join(root, 'notes', 'b.txt')))
    assert.equal(await readFile(join(root, 'notes', 'mine.txt'), 'utf8'), 'mine')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFolder leaves a file the user edited alone, and says so', async () => {
  const root = await tmp('repot-apply-')
  try {
    const roots = [{ id: 'work', path: root }]
    const first = [f('files/f1/a.txt', 'A')]
    await applyFolder({ item: { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', first) }, roots, files: first })

    // The other machine now has a newer version, but this file was edited here
    // after the last restore: it is a conflict, not an overwrite.
    await writeFile(join(root, 'notes', 'a.txt'), 'edited here', 'utf8')
    const second = [f('files/f1/a.txt', 'A2')]
    const result = await applyFolder({
      item: { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', second) },
      roots,
      files: second,
    })

    assert.equal(result.status, 'applied')
    assert.equal(result.written, 0, 'nothing was written')
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0].relPath, 'a.txt')
    assert.equal(await readFile(join(root, 'notes', 'a.txt'), 'utf8'), 'edited here')

    const marker = JSON.parse(await readFile(join(root, 'notes', '.repot.json'), 'utf8'))
    assert.equal(marker.sha256, undefined, 'a folder that still holds local edits is not the remote folder')
    assert.deepEqual(marker.localChanges, ['a.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFolder backs up the file it replaces', async () => {
  const root = await tmp('repot-apply-')
  try {
    const roots = [{ id: 'work', path: root }]
    const backupDir = join(root, '.repot-backup')
    const stamp = 'stamp-1'

    const first = [f('files/f1/a.txt', 'A')]
    await applyFolder({
      item: { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', first) },
      roots,
      files: first,
      backupDir,
      stamp,
    })

    const second = [f('files/f1/a.txt', 'A2')]
    const result = await applyFolder({
      item: { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', second) },
      roots,
      files: second,
      backupDir,
      stamp,
    })

    assert.equal(result.written, 1)
    assert.equal(result.backedUp, 1)
    assert.equal(await readFile(join(root, 'notes', 'a.txt'), 'utf8'), 'A2')
    assert.equal(
      await readFile(join(backupDir, stamp, 'files', 'f1', 'a.txt'), 'utf8'),
      'A',
      'the replaced content is recoverable',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFolder keeps a file the user changed instead of pruning it', async () => {
  const root = await tmp('repot-apply-')
  try {
    const roots = [{ id: 'work', path: root }]
    const first = [f('files/f1/a.txt', 'A'), f('files/f1/b.txt', 'B')]
    await applyFolder({ item: { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', first) }, roots, files: first })

    await writeFile(join(root, 'notes', 'b.txt'), 'my version', 'utf8')

    const second = [f('files/f1/a.txt', 'A')]
    const result = await applyFolder({
      item: { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', second) },
      roots,
      files: second,
    })

    assert.equal(result.removed, 0, 'a locally edited file is never deleted')
    assert.deepEqual(result.keptLocal.map((k) => k.relPath), ['b.txt'])
    assert.equal(await readFile(join(root, 'notes', 'b.txt'), 'utf8'), 'my version')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFolder rewrites nothing when the folder already matches', async () => {
  const root = await tmp('repot-apply-')
  try {
    const roots = [{ id: 'work', path: root }]
    const files = [f('files/f1/a.txt', 'A'), f('files/f1/b/c.txt', 'C')]
    const item = { id: 'f1', rootId: 'work', relPath: 'notes', sha256: folderSha('f1', files) }

    await applyFolder({ item, roots, files })
    const again = await applyFolder({ item, roots, files })

    assert.equal(again.written, 0)
    assert.equal(again.removed, 0)
    assert.equal(again.backedUp, 0)
    assert.equal(again.conflicts.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFolder refuses a directory it does not own', async () => {
  const root = await tmp('repot-apply-')
  try {
    await mkdir(join(root, 'foreign'), { recursive: true })
    await writeFile(join(root, 'foreign', 'keep.txt'), 'keep', 'utf8')

    const files = [f('files/f2/x.txt', 'x')]
    const result = await applyFolder({
      item: { id: 'f2', rootId: 'work', relPath: 'foreign', sha256: folderSha('f2', files) },
      roots: [{ id: 'work', path: root }],
      files,
    })

    assert.equal(result.status, 'refused')
    assert.match(result.reason, /拒绝覆盖/)
    assert.equal(await readFile(join(root, 'foreign', 'keep.txt'), 'utf8'), 'keep')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applyFolder rejects traversal and a hash mismatch', async () => {
  const root = await tmp('repot-apply-')
  try {
    const roots = [{ id: 'work', path: root }]

    const evil = [f('files/f3/../escape.txt', 'x')]
    const escaped = await applyFolder({
      item: { id: 'f3', rootId: 'work', relPath: 'notes', sha256: null },
      roots,
      files: evil,
    })
    assert.equal(escaped.status, 'failed')
    assert.match(escaped.reason, /非法相对路径/)

    const good = [f('files/f4/a.txt', 'A')]
    const bad = await applyFolder({
      item: { id: 'f4', rootId: 'work', relPath: 'other', sha256: 'deadbeef' },
      roots,
      files: good,
    })
    assert.equal(bad.status, 'failed')
    assert.match(bad.reason, /内容校验不通过/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rewriteFileSpecs relativises carried plugins and drops unknown paths', () => {
  const input = JSON.stringify({
    name: 'p',
    dependencies: {
      'my-plugin': 'file:D:/work/plugins/my-plugin',
      'stale-plugin': 'file:D:/gone/stale-plugin',
      'registry-dep': '1.2.3',
    },
  })
  const { text, changes, dropped } = rewriteFileSpecs(input, [{ name: 'my-plugin' }])
  const parsed = JSON.parse(text)

  assert.equal(parsed.dependencies['my-plugin'], 'file:./plugins/my-plugin')
  assert.equal(parsed.dependencies['registry-dep'], '1.2.3')
  assert.equal(parsed.dependencies['stale-plugin'], undefined)
  assert.equal(changes.length, 1)
  assert.equal(dropped.length, 1)
  assert.equal(dropped[0].name, 'stale-plugin')
})

test('rewriteFileSpecs tolerates invalid JSON with a clear message', () => {
  assert.throws(() => rewriteFileSpecs('{ nope', []), /不是合法 JSON/)
})

test('applyConfig backs up first, then rewrites package.json', async () => {
  const profile = await tmp('repot-prof-')
  try {
    const original = JSON.stringify({ name: 'p', dependencies: { 'a-plugin': 'file:D:/x/a-plugin' } }, null, 2)
    await writeFile(join(profile, 'package.json'), original, 'utf8')
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: old\n', 'utf8')

    const result = await applyConfig({
      profileDir: profile,
      items: [{ relPath: 'package.json' }, { relPath: 'cordis.patch.yml' }],
      files: [
        f('config/package.json', original),
        f('config/cordis.patch.yml', '- id: new\n'),
      ],
      sourcePlugins: [{ name: 'a-plugin' }],
      stamp: 'test-stamp',
    })

    assert.equal(result.results.length, 2)
    assert.ok(result.results[0].backedUp)

    const backup = await readFile(join(profile, '.repot', 'backup', 'test-stamp', 'package.json'), 'utf8')
    assert.equal(backup, original)

    const written = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    assert.equal(written.dependencies['a-plugin'], 'file:./plugins/a-plugin')

    const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.equal(patch, '- id: new\n')
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('applyPlugins installs registry, tarball and source shapes', async () => {
  const profile = await tmp('repot-prof-')
  const pluginsDir = join(profile, 'plugins')
  const calls = []
  const pluginManager = {
    async installBundle(spec, options) {
      calls.push({ spec, options })
      return { application: 'applied', target: spec, changed: true, stage: 'install' }
    },
  }
  try {
    const payloads = new Map([
      ['packages/pack.tgz', Buffer.from('tgz')],
      ['plugins/src-plugin/index.js', Buffer.from('export default 1')],
    ])

    const results = await applyPlugins({
      pluginManager,
      items: [
        { name: 'reg', version: '1.2.3', kind: 'registry', mode: 'registry' },
        { name: 'pack', version: '1.0.0', kind: 'tarball', mode: 'carry', file: 'packages/pack.tgz' },
        { name: 'src-plugin', version: '0.0.1', kind: 'source', mode: 'carry', dir: 'plugins/src-plugin' },
      ],
      payloads,
      pluginsDir,
    })

    assert.equal(results.length, 3)
    assert.ok(results.every((r) => r.status === 'installed'))

    assert.equal(calls[0].spec, 'reg@1.2.3')
    assert.deepEqual(calls[0].options, { saveExact: true })

    assert.ok(calls[1].spec.endsWith('pack.tgz'), 'the tarball is written to a temp file first')

    assert.equal(calls[2].spec, join(pluginsDir, 'src-plugin'))
    assert.equal(await readFile(join(pluginsDir, 'src-plugin', 'index.js'), 'utf8'), 'export default 1')
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('applyPlugins installs a dependency before its dependent', async () => {
  const calls = []
  const pluginManager = {
    async installBundle(spec) {
      calls.push(spec)
      return { application: 'applied', target: spec }
    },
  }
  await applyPlugins({
    pluginManager,
    items: [
      { name: 'b', version: '1.0.0', mode: 'registry', kind: 'registry', deps: ['a'] },
      { name: 'a', version: '1.0.0', mode: 'registry', kind: 'registry', deps: [] },
    ],
    payloads: new Map(),
    pluginsDir: join(tmpdir(), 'unused'),
  })
  assert.deepEqual(calls, ['a@1.0.0', 'b@1.0.0'], 'the dependency is installed first')
})

test('applyPlugins reports missing payloads instead of installing garbage', async () => {
  const pluginManager = {
    async installBundle() {
      throw new Error('must not be called')
    },
  }
  const results = await applyPlugins({
    pluginManager,
    items: [{ name: 'pack', version: '1.0.0', kind: 'tarball', mode: 'carry', file: 'packages/gone.tgz' }],
    payloads: new Map(),
    pluginsDir: join(tmpdir(), 'unused'),
  })
  assert.equal(results[0].status, 'missing-payload')
})
