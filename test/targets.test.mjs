import { test } from 'node:test'
import assert from 'node:assert/strict'

import { blankSettings, normalizeSettings } from '../lib/settings.js'
import { defaultTarget, groupByTarget, resolveTarget, resolvedTargets, targetLabel } from '../lib/targets.js'

function settingsWith(overrides = {}) {
  return {
    ...blankSettings(),
    platform: 'github',
    profiles: {
      github: { repo: 'me/github-remote', branch: 'main' },
      gitee: { repo: 'me/gitee-remote', branch: 'master' },
    },
    ...overrides,
  }
}

test('defaultTarget follows the platform profile', () => {
  const settings = settingsWith({ platform: 'gitee' })
  assert.deepEqual(defaultTarget(settings), { platform: 'gitee', repo: 'me/gitee-remote', branch: 'master' })
  assert.deepEqual(defaultTarget(settingsWith()), { platform: 'github', repo: 'me/github-remote', branch: 'main' })
})

test('resolveTarget prefers the per-set override and falls back to the default', () => {
  const settings = settingsWith({
    targets: { plugins: null, config: null, files: { platform: 'gitee', repo: 'me/files', branch: 'trunk' } },
  })
  assert.deepEqual(resolveTarget(settings, 'files'), { platform: 'gitee', repo: 'me/files', branch: 'trunk' })
  assert.deepEqual(resolveTarget(settings, 'plugins'), { platform: 'github', repo: 'me/github-remote', branch: 'main' })
})

test('an override without a branch gets the platform default branch', () => {
  const settings = settingsWith({
    targets: { plugins: null, config: null, files: { platform: 'gitee', repo: 'me/files', branch: '' } },
  })
  assert.equal(resolveTarget(settings, 'files').branch, 'master')
})

test('groupByTarget collapses sets that share a repository', () => {
  const settings = settingsWith({
    targets: { plugins: null, config: null, files: { platform: 'gitee', repo: 'me/files', branch: 'main' } },
  })
  const groups = groupByTarget(settings, ['plugins', 'config', 'files'])
  assert.equal(groups.length, 2)

  const github = groups.find((g) => g.target.repo === 'me/github-remote')
  const gitee = groups.find((g) => g.target.repo === 'me/files')
  assert.deepEqual(github.sets.sort(), ['config', 'plugins'])
  assert.deepEqual(gitee.sets, ['files'])
})

test('groupByTarget keeps sets that have no repository instead of dropping them', () => {
  const settings = settingsWith({
    profiles: { github: { repo: '', branch: 'main' }, gitee: { repo: '', branch: 'master' } },
  })
  const groups = groupByTarget(settings, ['config'])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].target.repo, '')
  assert.deepEqual(groups[0].sets, ['config'])
})

test('resolvedTargets reports every set', () => {
  const settings = settingsWith({
    targets: { plugins: null, config: { platform: 'gitee', repo: 'me/cfg', branch: 'main' }, files: null },
  })
  const resolved = resolvedTargets(settings)
  assert.equal(resolved.config.repo, 'me/cfg')
  assert.equal(resolved.plugins.repo, 'me/github-remote')
  assert.equal(resolved.files.repo, 'me/github-remote')
})

test('targetLabel is short and names the platform', () => {
  assert.equal(targetLabel({ platform: 'gitee', repo: 'a/b' }), 'gitee:a/b')
  assert.equal(targetLabel({ platform: 'github', repo: 'a/b' }), 'github:a/b')
  assert.equal(targetLabel({ platform: 'github', repo: '' }), '')
})

test('normalizeSettings keeps valid per-set targets and drops empty ones', () => {
  const { settings } = normalizeSettings({
    platform: 'github',
    profiles: { github: { repo: 'x/y', branch: 'main' }, gitee: { repo: '', branch: 'master' } },
    targets: {
      plugins: { platform: 'gitee', repo: 'g/p', branch: 'main' },
      config: { platform: 'gitee', repo: '', branch: 'main' },
      files: 'nonsense',
    },
  })
  assert.deepEqual(settings.targets.plugins, { platform: 'gitee', repo: 'g/p', branch: 'main' })
  assert.equal(settings.targets.config, null, 'an empty repo is not an override')
  assert.equal(settings.targets.files, null, 'a non-object is ignored')
})
