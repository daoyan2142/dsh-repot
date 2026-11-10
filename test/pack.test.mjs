import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'

import { compileFilesFilter, globToRegExp, packDirectory, planPackage } from '../lib/pack.js'

async function tmp(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

/** Minimal ustar reader — enough to prove what a tarball contains. */
function listTar(tgzBuffer) {
  const buf = gunzipSync(tgzBuffer)
  const names = []
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '')
    if (!name) break
    const sizeText = header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim()
    const size = sizeText ? parseInt(sizeText, 8) : 0
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '')
    names.push(prefix ? `${prefix}/${name}` : name)
    off += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

test('globToRegExp handles literals, stars and double stars', () => {
  assert.ok(globToRegExp('lib').test('lib'))
  assert.ok(globToRegExp('lib').test('lib/a.js'), 'a directory pattern selects its contents')
  assert.ok(!globToRegExp('lib').test('libextra/a.js'))
  assert.ok(globToRegExp('lib/*.js').test('lib/a.js'))
  assert.ok(!globToRegExp('lib/*.js').test('lib/nested/a.js'))
  assert.ok(globToRegExp('**/*.md').test('a/b/c.md'))
  assert.ok(globToRegExp('**/*.md').test('c.md'))
})

test('compileFilesFilter always keeps package.json, README and LICENSE', () => {
  const include = compileFilesFilter(['lib'])
  assert.equal(include('package.json', false), true)
  assert.equal(include('README.md', false), true)
  assert.equal(include('LICENSE', false), true)
  assert.equal(include('lib/a.js', false), true)
  assert.equal(include('docs/c.md', false), false)
})

test('packDirectory honours package.json#files', async () => {
  const dir = await tmp('repot-pack-')
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', files: ['lib'] }), 'utf8')
    await writeFile(join(dir, 'README.md'), '# x', 'utf8')
    await mkdir(join(dir, 'lib', 'nested'), { recursive: true })
    await writeFile(join(dir, 'lib', 'a.js'), 'export const a = 1', 'utf8')
    await writeFile(join(dir, 'lib', 'nested', 'b.js'), 'export const b = 2', 'utf8')
    await mkdir(join(dir, 'docs'), { recursive: true })
    await writeFile(join(dir, 'docs', 'guide.md'), 'docs', 'utf8')
    await writeFile(join(dir, 'stray.tgz'), 'not a package', 'utf8')

    const names = listTar(await packDirectory(dir))
    assert.ok(names.includes('package/package.json'))
    assert.ok(names.includes('package/README.md'))
    assert.ok(names.includes('package/lib/a.js'))
    assert.ok(names.includes('package/lib/nested/b.js'))
    assert.ok(!names.some((n) => n.includes('docs/')))
    assert.ok(!names.some((n) => n.endsWith('.tgz')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('packDirectory without a files field keeps the whole tree minus skips', async () => {
  const dir = await tmp('repot-pack-')
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'y' }), 'utf8')
    await writeFile(join(dir, 'index.js'), 'x', 'utf8')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'sub', 'deep.js'), 'y', 'utf8')
    await mkdir(join(dir, 'node_modules', 'z'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'z', 'index.js'), 'no', 'utf8')

    const names = listTar(await packDirectory(dir))
    assert.ok(names.includes('package/index.js'))
    assert.ok(names.includes('package/sub/deep.js'))
    assert.ok(!names.some((n) => n.includes('node_modules')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a junction-installed package packs its real content', async (t) => {
  const base = await tmp('repot-pack-')
  const realDir = join(base, 'real')
  const linkDir = join(base, 'linked')
  try {
    await mkdir(realDir, { recursive: true })
    await writeFile(join(realDir, 'package.json'), JSON.stringify({ name: 'z' }), 'utf8')
    await writeFile(join(realDir, 'index.js'), 'real', 'utf8')
    try {
      await symlink(realDir, linkDir, 'junction')
    } catch {
      t.skip('junction not permitted in this environment')
      return
    }

    const plan = await planPackage(linkDir)
    assert.equal(plan.root.toLowerCase(), realDir.toLowerCase(), 'the junction is realpath\'d before packing')
    const names = listTar(await packDirectory(linkDir))
    assert.ok(names.includes('package/index.js'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('packDirectory refuses a package over the size ceiling', async () => {
  const dir = await tmp('repot-pack-')
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'big' }), 'utf8')
    await writeFile(join(dir, 'blob.bin'), Buffer.alloc(4096))
    await assert.rejects(() => packDirectory(dir, { maxTotalBytes: 1024 }), /超过上限/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
