/**
 * Settings, schema version 2.
 *
 * v1 (dsh-plugin-git-sync) was `{ platform, profiles }` and knew nothing about
 * sync roots or sync sets. v2 keeps the same repository configuration and adds:
 *
 *   roots  — 1..3 sync roots, each `{ id, path }`; `id` is the stable anchor
 *            that survives a machine change, `path` is this machine's answer
 *   sets   — which of the three sets are enabled
 *   limits — size ceilings applied during scan
 *
 * The file lives at `<profile>/.repot/settings.json`. The v1 file is read once
 * and never modified, so a rollback to the old plugin still finds its data.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { profileDirectory } from './paths.js'
import { isDriveRoot, isInside, normalizeForCompare } from './pathutil.js'

export const SETTINGS_VERSION = 3
export const MAX_ROOTS = 3
export const SET_NAMES = ['plugins', 'config', 'files']

export const DEFAULT_BRANCH = Object.freeze({ github: 'main', gitee: 'master' })
export const DEFAULT_SETS = Object.freeze({ plugins: true, config: true, files: true })
export const DEFAULT_LIMITS = Object.freeze({
  maxFileMB: 10,
  maxSetMB: 500,
  maxUploadFiles: 300,
  maxUploadMB: 50,
})

const DIR_NAME = '.repot'
const LEGACY_DIR_NAME = '.git-sync'
const ROOT_ID = /^[a-z][a-z0-9_-]{0,31}$/

/** `<profile>/.repot` */
export function repotDirectory(profileDir) {
  return join(profileDir, DIR_NAME)
}

/** `<profile>/.repot/settings.json` */
export function settingsPath(profileDir) {
  return join(repotDirectory(profileDir), 'settings.json')
}

/** `<profile>/.git-sync/settings.json` — read-only migration source. */
export function legacySettingsPath(profileDir) {
  return join(profileDir, LEGACY_DIR_NAME, 'settings.json')
}

/** A fresh default document. Roots start empty: no path is assumed. */
export function blankSettings() {
  return {
    version: SETTINGS_VERSION,
    platform: 'github',
    profiles: {
      github: { repo: '', branch: DEFAULT_BRANCH.github },
      gitee: { repo: '', branch: DEFAULT_BRANCH.gitee },
    },
    // Per-set repository override; `null` means "use the default profile".
    targets: { plugins: null, config: null, files: null },
    roots: [],
    sets: { ...DEFAULT_SETS },
    limits: { ...DEFAULT_LIMITS },
  }
}

/** Coerce one per-set target, or null when it is absent/unusable. */
export function normalizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
  if (!repo) return null
  const platform = raw.platform === 'gitee' ? 'gitee' : 'github'
  const branch = typeof raw.branch === 'string' && raw.branch.trim() ? raw.branch.trim() : DEFAULT_BRANCH[platform]
  return { platform, repo, branch }
}

function asString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * Validate a root list without touching the filesystem.
 * Returns `{ roots, errors }`; `errors` is empty when the list is usable.
 */
export function validateRoots(list) {
  const errors = []
  const roots = []
  const input = Array.isArray(list) ? list : []
  if (input.length > MAX_ROOTS) errors.push(`最多 ${MAX_ROOTS} 个根`)

  for (const entry of input.slice(0, MAX_ROOTS)) {
    const id = asString(entry?.id, '').trim()
    const path = asString(entry?.path, '').trim()
    if (!ROOT_ID.test(id)) {
      errors.push(`根标识 "${id || '(空)'}" 不合法：需小写字母开头，仅含 a-z 0-9 _ -`)
      continue
    }
    if (!path) {
      errors.push(`根 "${id}" 缺少路径`)
      continue
    }
    if (isDriveRoot(path)) {
      errors.push(`根 "${id}" 不能是盘符根（${path}），请选具体目录`)
      continue
    }
    if (roots.some((r) => r.id === id)) {
      errors.push(`根标识 "${id}" 重复`)
      continue
    }
    roots.push({ id, path })
  }

  // Nested roots make relPath resolution ambiguous: reject them outright.
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i]
      const b = roots[j]
      if (isInside(a.path, b.path) || isInside(b.path, a.path)) {
        errors.push(`根 "${a.id}" 与 "${b.id}" 存在包含关系，请改用互不嵌套的目录`)
      }
    }
  }
  return { roots, errors }
}

/**
 * Coerce any raw object into a usable settings document.
 * Never throws; malformed pieces fall back to defaults and are reported.
 */
export function normalizeSettings(raw) {
  const out = blankSettings()
  const errors = []
  if (!raw || typeof raw !== 'object') return { settings: out, errors: ['设置文件不是对象，已重置'] }

  out.platform = raw.platform === 'gitee' ? 'gitee' : 'github'

  if (raw.profiles && typeof raw.profiles === 'object') {
    for (const key of ['github', 'gitee']) {
      const p = raw.profiles[key]
      if (p && typeof p === 'object') {
        out.profiles[key] = {
          repo: asString(p.repo, ''),
          branch: asString(p.branch, DEFAULT_BRANCH[key]) || DEFAULT_BRANCH[key],
        }
      }
    }
  } else if (typeof raw.repo === 'string' || typeof raw.branch === 'string') {
    // v1 single-repository shape.
    out.profiles[out.platform] = {
      repo: asString(raw.repo, ''),
      branch: asString(raw.branch, DEFAULT_BRANCH[out.platform]) || DEFAULT_BRANCH[out.platform],
    }
  }

  if (raw.sets && typeof raw.sets === 'object') {
    for (const key of ['plugins', 'config', 'files']) {
      if (typeof raw.sets[key] === 'boolean') out.sets[key] = raw.sets[key]
    }
  }

  if (raw.targets && typeof raw.targets === 'object') {
    for (const key of SET_NAMES) out.targets[key] = normalizeTarget(raw.targets[key])
  }

  if (raw.limits && typeof raw.limits === 'object') {
    out.limits = {
      maxFileMB: clampInt(raw.limits.maxFileMB, 1, 100, DEFAULT_LIMITS.maxFileMB),
      maxSetMB: clampInt(raw.limits.maxSetMB, 1, 4096, DEFAULT_LIMITS.maxSetMB),
      maxUploadFiles: clampInt(raw.limits.maxUploadFiles, 1, 5000, DEFAULT_LIMITS.maxUploadFiles),
      maxUploadMB: clampInt(raw.limits.maxUploadMB, 1, 2048, DEFAULT_LIMITS.maxUploadMB),
    }
  }

  const checked = validateRoots(raw.roots)
  out.roots = checked.roots
  errors.push(...checked.errors)

  return { settings: out, errors }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Write via a temp file + rename so an interrupted save cannot truncate. */
async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, file)
}

/**
 * Load settings, migrating a v1 file on first run.
 * Returns `{ settings, source, warnings }` where source is
 * `'v2' | 'migrated' | 'default'`.
 */
export async function loadSettings(ctx) {
  const profileDir = await profileDirectory(ctx)
  const current = await readJson(settingsPath(profileDir))
  if (current) {
    const { settings, errors } = normalizeSettings(current)
    return { settings, source: 'saved', warnings: errors, profileDir }
  }

  const legacy = await readJson(legacySettingsPath(profileDir))
  if (legacy) {
    const { settings, errors } = normalizeSettings(legacy)
    return { settings, source: 'migrated', warnings: errors, profileDir }
  }

  return { settings: blankSettings(), source: 'default', warnings: [], profileDir }
}

/**
 * Apply a patch and persist. `migrated` sources are persisted on the first
 * save so the v1 file can stay untouched as a rollback copy.
 */
export async function saveSettings(ctx, patch) {
  const { settings, profileDir } = await loadSettings(ctx)
  const next = normalizeSettings({ ...settings, ...(patch ?? {}) }).settings
  await writeJsonAtomic(settingsPath(profileDir), next)
  return { settings: next, profileDir }
}

/** Turn the current repository profile into the flat shape the UI consumes. */
export function currentProfile(settings) {
  const chosen = settings.profiles[settings.platform] ?? { repo: '', branch: DEFAULT_BRANCH[settings.platform] }
  return {
    platform: settings.platform,
    repo: chosen.repo,
    branch: chosen.branch || DEFAULT_BRANCH[settings.platform],
  }
}

/** The root that contains `target`, or undefined. Longest match wins. */
export function rootFor(target, roots) {
  let best
  for (const root of roots ?? []) {
    if (!isInside(target, root.path)) continue
    if (!best || normalizeForCompare(root.path).length > normalizeForCompare(best.path).length) best = root
  }
  return best
}
