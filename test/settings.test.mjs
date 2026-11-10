import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  blankSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
  validateRoots,
} from '../lib/settings.js'

async function tempProfile() {
  return realpath(await mkdtemp(join(tmpdir(), 'repot-test-')))
}

test('blankSettings is a usable v3 document', () => {
  const s = blankSettings()
  assert.equal(s.version, 3)
  assert.deepEqual(s.roots, [])
  assert.deepEqual(s.sets, { plugins: true, config: true, files: true })
  assert.deepEqual(s.targets, { plugins: null, config: null, files: null })
  assert.equal(s.profiles.github.branch, 'main')
  assert.equal(s.profiles.gitee.branch, 'master')
})

test('normalizeSettings lifts a v1 document without losing the repository', () => {
  const v1 = {
    platform: 'gitee',
    profiles: {
      github: { repo: '', branch: 'main' },
      gitee: { repo: 'https://gitee.com/o/r.git', branch: 'trunk' },
    },
  }
  const { settings, errors } = normalizeSettings(v1)
  assert.deepEqual(errors, [])
  assert.equal(settings.version, 3)
  assert.equal(settings.platform, 'gitee')
  assert.equal(settings.profiles.gitee.repo, 'https://gitee.com/o/r.git')
  assert.equal(settings.profiles.gitee.branch, 'trunk')
  assert.deepEqual(settings.roots, [])
})

test('normalizeSettings reads the oldest single-repository shape', () => {
  const { settings } = normalizeSettings({ platform: 'gitee', repo: 'o/r', branch: 'dev' })
  assert.equal(settings.profiles.gitee.repo, 'o/r')
  assert.equal(settings.profiles.gitee.branch, 'dev')
})

test('normalizeSettings never throws on garbage', () => {
  for (const raw of [null, 42, 'x', [], { roots: 'nope' }, { sets: 5 }]) {
    assert.doesNotThrow(() => normalizeSettings(raw))
  }
})

test('validateRoots rejects a bare drive root', () => {
  const { errors } = validateRoots([{ id: 'c', path: 'C:\\' }])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /盘符根/)
})

test('validateRoots rejects nested roots', () => {
  const { errors } = validateRoots([
    { id: 'a', path: 'D:\\work' },
    { id: 'b', path: 'D:\\work\\sub' },
  ])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /包含关系/)
})

test('validateRoots rejects duplicate ids and too many roots', () => {
  assert.equal(validateRoots([{ id: 'a', path: 'D:\\one' }, { id: 'a', path: 'D:\\two' }]).errors.length, 1)
  const many = [1, 2, 3, 4].map((n) => ({ id: 'r' + n, path: 'D:\\dir' + n }))
  assert.ok(validateRoots(many).errors.length >= 1)
})

test('validateRoots accepts a normal pair', () => {
  const { roots, errors } = validateRoots([
    { id: 'work', path: 'D:\\work' },
    { id: 'src', path: 'D:\\work-plugins' },
  ])
  assert.deepEqual(errors, [])
  assert.equal(roots.length, 2)
})

test('loadSettings reports migrated from the v1 file and writes the current file separately', async () => {
  const profile = await tempProfile()
  try {
    await mkdir(join(profile, '.git-sync'), { recursive: true })
    const v1 = { platform: 'gitee', profiles: { github: { repo: '', branch: 'main' }, gitee: { repo: 'o/r', branch: 'main' } } }
    const v1Path = join(profile, '.git-sync', 'settings.json')
    await writeFile(v1Path, JSON.stringify(v1), 'utf8')

    const ctx = { get: () => undefined }
    process.env.DSH_PROFILE_DIR = profile

    const loaded = await loadSettings(ctx)
    assert.equal(loaded.source, 'migrated')
    assert.equal(loaded.settings.profiles.gitee.repo, 'o/r')

    await saveSettings(ctx, { roots: [{ id: 'work', path: 'D:\\work' }] })

    const saved = JSON.parse(await readFile(join(profile, '.repot', 'settings.json'), 'utf8'))
    assert.equal(saved.version, 3)
    assert.equal(saved.roots.length, 1)

    // The v1 file must survive untouched.
    const untouched = JSON.parse(await readFile(v1Path, 'utf8'))
    assert.deepEqual(untouched, v1)

    const again = await loadSettings(ctx)
    assert.equal(again.source, 'saved')
  } finally {
    delete process.env.DSH_PROFILE_DIR
    await rm(profile, { recursive: true, force: true })
  }
})
