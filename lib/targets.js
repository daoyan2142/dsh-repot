/**
 * Which repository each set goes to.
 *
 * A set may name its own target; when it does not, it inherits the default
 * profile (the platform + repository chosen at the top of the settings page).
 * One set is always a single target — pushing to two hosts at once is
 * deliberately not a mode.
 */
import { DEFAULT_BRANCH } from './settings.js'

function normalisePlatform(value) {
  return value === 'gitee' ? 'gitee' : 'github'
}

/** The default target: the platform profile the settings page edits. */
export function defaultTarget(settings) {
  const platform = normalisePlatform(settings?.platform)
  const profile = (settings?.profiles && settings.profiles[platform]) || {}
  return {
    platform,
    repo: typeof profile.repo === 'string' ? profile.repo : '',
    branch: (typeof profile.branch === 'string' && profile.branch) || DEFAULT_BRANCH[platform],
  }
}

/** The target for one set: its own override, or the default. */
export function resolveTarget(settings, set) {
  const override = settings?.targets ? settings.targets[set] : null
  if (override && typeof override.repo === 'string' && override.repo.trim()) {
    const platform = normalisePlatform(override.platform)
    return {
      platform,
      repo: override.repo.trim(),
      branch: (typeof override.branch === 'string' && override.branch.trim()) || DEFAULT_BRANCH[platform],
    }
  }
  return defaultTarget(settings)
}

export function targetKey(target) {
  return `${target.platform}|${target.repo}|${target.branch}`
}

/** A short label for the UI, e.g. `gitee:owner/repo`. */
export function targetLabel(target) {
  if (!target || !target.repo) return ''
  return `${target.platform === 'gitee' ? 'gitee' : 'github'}:${target.repo}`
}

/**
 * Group the requested sets by the repository they land in.
 * Sets with no repository at all are returned too, so the caller can report
 * them instead of silently dropping their content.
 */
export function groupByTarget(settings, sets) {
  const wanted = Array.isArray(sets) && sets.length ? sets : ['plugins', 'config', 'files']
  const groups = []
  const byKey = new Map()

  for (const set of wanted) {
    const target = resolveTarget(settings, set)
    if (!target.repo) {
      groups.push({ target, sets: [set] })
      continue
    }
    const key = targetKey(target)
    let group = byKey.get(key)
    if (!group) {
      group = { target, sets: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    group.sets.push(set)
  }

  return groups
}

/** Every set this configuration would write, with its resolved target. */
export function resolvedTargets(settings) {
  const out = {}
  for (const set of ['plugins', 'config', 'files']) out[set] = resolveTarget(settings, set)
  return out
}
