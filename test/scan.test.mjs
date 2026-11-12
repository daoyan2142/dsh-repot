import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { scanConfig } from '../lib/scan/config.js'
import { scanFolder } from '../lib/scan/files.js'
import { HEAVY_BYTES, orderByDependencies, scanPlugins } from '../lib/scan/plugins.js'

async function tmp(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

test('scanConfig carries three files and reports the generated root and lockfile as skipped', async () => {
  const dir = await tmp('repot-cfg-')
  try {
    for (const name of ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml']) {
      await writeFile(join(dir, name), 'x', 'utf8')
    }
    const result = await scanConfig(dir)
    assert.deepEqual(
      result.items.map((i) => i.relPath).sort(),
      ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml'],
    )
    assert.ok(result.skipped.some((s) => s.relPath === 'cordis.yml' && s.reason === 'generated'))
    assert.ok(result.skipped.some((s) => s.relPath === 'pnpm-lock.yaml' && s.reason === 'machine-specific'))
    assert.equal(result.bytes, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanConfig tolerates a profile missing optional files', async () => {
  const dir = await tmp('repot-cfg-')
  try {
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')
    const result = await scanConfig(dir)
    assert.equal(result.items.length, 1)
    assert.ok(result.skipped.some((s) => s.relPath === 'cordis.patch.yml' && s.reason === 'missing'))
    assert.ok(result.skipped.some((s) => s.relPath === 'pnpm-lock.yaml' && s.reason === 'machine-specific'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanFolder skips node_modules, flags symlinks and honours the size cap', async () => {
  const dir = await tmp('repot-files-')
  try {
    await mkdir(join(dir, 'sub'), { recursive: true })
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(dir, 'sub', 'a.txt'), 'hello', 'utf8')
    await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'ignored', 'utf8')
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(2048))

    const result = await scanFolder(dir, { maxFileMB: 0.001 }) // ~1 KB ceiling
    assert.equal(result.gitManaged, false)
    assert.equal(result.selectable, true)
    assert.deepEqual(
      result.files.map((f) => f.relPath),
      ['sub/a.txt'],
    )
    assert.ok(result.skipped.some((s) => s.relPath === 'big.bin' && s.reason === 'too-large'))
    assert.ok(result.skipped.some((s) => s.relPath === 'node_modules' && s.reason === 'skip-dir'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanFolder marks a Git working tree as not selectable', async () => {
  const dir = await tmp('repot-files-')
  try {
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'x', 'utf8')
    const result = await scanFolder(dir, {})
    assert.equal(result.gitManaged, true)
    assert.equal(result.selectable, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanPlugins classifies registry, source and tarball installs', async () => {
  const profile = await tmp('repot-prof-')
  const sourceDir = await tmp('repot-src-')
  const distDir = await tmp('repot-dist-')
  try {
    // A source plugin linked with file:
    await writeFile(
      join(sourceDir, 'package.json'),
      JSON.stringify({ name: 'link-plugin', version: '2.0.0', dependencies: { 'dep-plugin': '1.0.0' } }),
      'utf8',
    )
    await writeFile(join(sourceDir, 'index.js'), 'export const x = 1', 'utf8')

    // A tarball-installed plugin
    const tgz = join(distDir, 'packed-plugin.tgz')
    await writeFile(tgz, Buffer.from('not-a-real-tgz'))

    await writeFile(
      join(profile, 'package.json'),
      JSON.stringify({
        dependencies: {
          'link-plugin': 'file:' + sourceDir.replace(/\\/g, '/'),
          'packed-plugin': 'file:' + tgz.replace(/\\/g, '/'),
        },
      }),
      'utf8',
    )

    const pluginManager = {
      async listBundles() {
        return [
          { name: '@deepseek-ai/dsh-base', official: true, installed: true },
          { name: 'link-plugin', official: false, installed: true, version: '2.0.0' },
          { name: 'packed-plugin', official: false, installed: true, version: '1.2.3' },
          { name: 'registry-plugin', official: false, installed: false },
        ]
      },
    }

    const result = await scanPlugins({ pluginManager, profileDir: profile })
    const byName = Object.fromEntries(result.items.map((i) => [i.name, i]))

    // The file: classification wins over the bundle record.
    assert.equal(byName['link-plugin'].kind, 'source')
    assert.equal(byName['link-plugin'].version, '2.0.0')
    assert.equal(byName['link-plugin'].fileCount, 2)
    assert.deepEqual(byName['link-plugin'].deps, ['dep-plugin'])

    assert.equal(byName['packed-plugin'].kind, 'tarball')
    assert.equal(byName['packed-plugin'].version, '1.2.3')

    // Official and not-installed bundles never appear.
    assert.equal(byName['@deepseek-ai/dsh-base'], undefined)
    assert.equal(byName['registry-plugin'], undefined)
    assert.equal(result.items.length, 2)
  } finally {
    await rm(profile, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
    await rm(distDir, { recursive: true, force: true })
  }
})

test('scanPlugins excludes this plugin itself and flags heavy packages', async () => {
  const profile = await tmp('repot-prof-')
  try {
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')

    for (const name of ['huge', 'plain']) {
      const dir = join(profile, 'node_modules', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }), 'utf8')
      await writeFile(join(dir, 'index.js'), 'x', 'utf8')
    }
    // A sparse file is enough: the walker only needs the logical size.
    // (truncate() needs the file to exist on Windows, so create it first.)
    const media = join(profile, 'node_modules', 'huge', 'media.mp4')
    await writeFile(media, '')
    await truncate(media, HEAVY_BYTES + 1)

    const pluginManager = {
      async listBundles() {
        return [
          { name: 'huge', official: false, installed: true, version: '1.0.0' },
          { name: 'plain', official: false, installed: true, version: '1.0.0' },
          { name: 'dsh-repot', official: false, installed: true, version: '0.1.0' },
        ]
      },
    }

    const result = await scanPlugins({ pluginManager, profileDir: profile })
    const byName = Object.fromEntries(result.items.map((i) => [i.name, i]))

    assert.equal(byName['dsh-repot'], undefined, 'the plugin never carries itself')
    assert.equal(byName.huge.heavy, true)
    assert.equal(byName.plain.heavy, false)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('orderByDependencies places a dependency before its dependent', () => {
  const items = [
    { name: 'a', deps: ['b'] },
    { name: 'b', deps: ['c'] },
    { name: 'c', deps: [] },
  ]
  assert.deepEqual(
    orderByDependencies(items).map((i) => i.name),
    ['c', 'b', 'a'],
  )
})

test('orderByDependencies survives a cycle without hanging', () => {
  const items = [
    { name: 'a', deps: ['b'] },
    { name: 'b', deps: ['a'] },
  ]
  const out = orderByDependencies(items).map((i) => i.name)
  assert.equal(out.length, 2)
  assert.deepEqual(out.sort(), ['a', 'b'])
})
