/**
 * dsh-repot — Host half.
 *
 * One private GitHub/Gitee repository carries a DSH environment between
 * machines. Three sets are carried: plugins, configuration, and folders.
 *
 * Invariants this half enforces:
 *   - every filesystem write is proven to be inside a registered root
 *     (lib/guard.js), never merely suggested by the client
 *   - the PAT lives only in the credentials service, never in settings,
 *     never in a response, never in a commit message
 *   - a v1 (dsh-plugin-git-sync) settings file is read once and never mutated
 */
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getFileBuffer, platformFromRepo, verifyRepo } from './lib/git.js'
import {
  currentProfile,
  loadSettings,
  normalizeTarget,
  rootFor,
  saveSettings,
  validateRoots,
} from './lib/settings.js'
import { groupByTarget, resolveTarget, resolvedTargets } from './lib/targets.js'
import { assertRootsExist, preflight, GuardError } from './lib/guard.js'
import { clearToken, getToken, migrateTokens, saveToken, tokenSummary } from './lib/tokens.js'
import { scanConfig } from './lib/scan/config.js'
import { scanFolder } from './lib/scan/files.js'
import { scanPlugins } from './lib/scan/plugins.js'
import { collectPayload } from './lib/collect.js'
import { buildManifest, manifestToFile, readManifest, sha256 } from './lib/manifest.js'
import { uploadFiles } from './lib/remote/upload.js'
import { compareConfig, compareFiles, comparePlugins } from './lib/compare.js'
import { diffFolder, hashFolder, indexFiles } from './lib/dirdiff.js'
import { appendHistory, readHistory } from './lib/history.js'
import { applyConfig } from './lib/apply/config.js'
import { applyFolder, FOLDER_INDEX_NAME, folderPrefix } from './lib/apply/files.js'
import { applyPlugins } from './lib/apply/plugins.js'

export const name = 'dsh-repot'
export const inject = ['webServer', 'connection']

const API_PREFIX = '/repot/api/'
const MAX_BODY_BYTES = 32 * 1024 * 1024

export function apply(ctx) {
  // This plugin ships its own page; tell Settings not to render a generic one.
  const settings = ctx.get('settings')
  if (settings?.configure) {
    try {
      ctx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'dsh-repot: settings policy')
    } catch {
      /* Settings absent on this profile */
    }
  }

  // Copy legacy PATs once, before the first request can look for them.
  void migrateTokens(ctx).catch(() => {})

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/repot/api',
        handler: (req, res) => handleRequest(ctx, req, res),
      }),
    'dsh-repot: /repot/api routes',
  )
}

// ------------------------------------------------------------- operations ---

async function handlerState(ctx) {
  const { settings, source, warnings } = await loadSettings(ctx)
  const current = currentProfile(settings)
  return {
    version: settings.version,
    platform: current.platform,
    repo: current.repo,
    branch: current.branch,
    profiles: settings.profiles,
    targets: settings.targets,
    resolved: resolvedTargets(settings),
    roots: settings.roots,
    sets: settings.sets,
    limits: settings.limits,
    tokens: await tokenSummary(ctx),
    migrated: source === 'migrated',
    warnings,
  }
}

async function handlerSaveSettings(ctx, body) {
  const { settings } = await loadSettings(ctx)
  const platform = platformFromRepo(body?.repo) ?? (body?.platform === 'gitee' ? 'gitee' : settings.platform)
  const previous = settings.profiles[platform] ?? { repo: '', branch: platform === 'gitee' ? 'master' : 'main' }

  const patch = {
    platform,
    profiles: {
      ...settings.profiles,
      [platform]: {
        repo: typeof body?.repo === 'string' ? body.repo : previous.repo,
        branch:
          (typeof body?.branch === 'string' && body.branch.trim()) ||
          previous.branch ||
          (platform === 'gitee' ? 'master' : 'main'),
      },
    },
  }

  if (Array.isArray(body?.sets)) {
    patch.sets = { ...settings.sets }
    for (const key of ['plugins', 'config', 'files']) {
      if (body.sets.includes(key)) patch.sets[key] = true
    }
  } else if (body?.sets && typeof body.sets === 'object') {
    patch.sets = { ...settings.sets, ...body.sets }
  }

  if (body?.limits && typeof body.limits === 'object') {
    patch.limits = { ...settings.limits, ...body.limits }
  }

  // Per-set targets: an object keyed by set name; null/empty clears the override.
  if (body?.targets && typeof body.targets === 'object' && !Array.isArray(body.targets)) {
    patch.targets = { ...settings.targets }
    for (const key of ['plugins', 'config', 'files']) {
      if (!Object.hasOwn(body.targets, key)) continue
      patch.targets[key] = normalizeTarget(body.targets[key])
    }
  }

  if (Array.isArray(body?.roots)) {
    const checked = validateRoots(body.roots)
    if (checked.errors.length) throw new GuardError('invalid-roots', checked.errors.join('；'))
    await assertRootsExist(checked.roots)
    patch.roots = checked.roots
  }

  await saveSettings(ctx, patch)
  return handlerState(ctx)
}

async function handlerVerify(ctx, body) {
  const { settings } = await loadSettings(ctx)
  const current = currentProfile(settings)
  const repo = typeof body?.repo === 'string' && body.repo ? body.repo : current.repo
  const platform = platformFromRepo(repo) ?? (body?.platform === 'gitee' ? 'gitee' : current.platform)
  if (!repo) throw new Error('repo is required')
  const token = (typeof body?.token === 'string' && body.token) || (await getToken(ctx, platform))
  if (!token) throw new Error('token not configured')
  return verifyRepo({ platform, repo, token })
}

async function handlerPreflight(ctx, body) {
  const { settings } = await loadSettings(ctx)
  const roots = Array.isArray(body?.roots) ? body.roots : settings.roots
  if (!roots.length) throw new GuardError('no-roots', '尚未配置任何根')
  const items = Array.isArray(body?.items) ? body.items : []
  return { roots, results: await preflight(items, { roots }) }
}

/**
 * Read-only inventory of what could be carried. `folders` must sit inside a
 * registered root — scanning is a read, but reading an arbitrary drive path is
 * still something the caller has no business doing here.
 */
async function handlerScan(ctx, body) {
  const { settings, profileDir } = await loadSettings(ctx)
  const wanted =
    Array.isArray(body?.sets) && body.sets.length
      ? new Set(body.sets)
      : new Set(['plugins', 'config', 'files'])
  const out = { sets: [...wanted] }

  if (wanted.has('plugins')) {
    out.plugins = await scanPlugins({ pluginManager: ctx.get('pluginManager'), profileDir })
  }
  if (wanted.has('config')) {
    out.config = await scanConfig(profileDir)
  }
  if (wanted.has('files')) {
    const folders = []
    for (const absPath of Array.isArray(body?.folders) ? body.folders : []) {
      if (!rootFor(absPath, settings.roots)) {
        folders.push({ absPath, selectable: false, error: '不在任何已登记的根内' })
        continue
      }
      folders.push(await scanFolder(absPath, settings.limits))
    }
    out.files = { folders }
  }
  return out
}

/** Stable id for a folder: same root id + same relative path → same id anywhere. */
function folderId(rootId, relPath) {
  const slug = String(relPath || '.')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${rootId}-${slug || 'root'}`
}

/**
 * Derive `{ id, absPath, rootId, relPath }` for each requested folder.
 * The relative path is what survives a machine change, so it is computed here
 * rather than trusted from the client.
 */
function folderSpecs(requested, roots) {
  const specs = []
  for (const entry of requested ?? []) {
    const absPath = typeof entry === 'string' ? entry : entry?.absPath
    if (!absPath) continue
    const root = rootFor(absPath, roots)
    if (!root) throw new GuardError('outside-roots', `不在任何已登记的根内：${absPath}`)
    const relPath = relative(root.path, absPath).split('\\').join('/')
    specs.push({
      id: entry?.id ?? folderId(root.id, relPath),
      absPath,
      rootId: root.id,
      relPath,
    })
  }
  return specs
}

/**
 * The repository's current index, if it can be read at all. A manifest left by
 * an older schema is treated as absent: it must not block a commit that carries
 * full content for its own sets.
 */
async function previousManifest(target, token) {
  try {
    const remote = await readManifest({ ...target, token })
    return remote.exists ? remote.manifest : undefined
  } catch {
    return undefined
  }
}

/** Keep the entries of sets this commit does not carry. Returns their names. */
function carryOver(manifest, previousSets, carriedSets) {
  const kept = []
  for (const set of ['plugins', 'config', 'files']) {
    if (carriedSets.includes(set)) continue
    const items = previousSets?.[set]?.items
    if (Array.isArray(items) && items.length) {
      manifest.sets[set].items = items
      kept.push(set)
    }
  }
  return kept
}

async function handlerUpload(ctx, body) {
  const { settings, profileDir } = await loadSettings(ctx)

  // No repository anywhere is a configuration error, not an empty selection.
  if (!['plugins', 'config', 'files'].some((set) => resolveTarget(settings, set).repo)) {
    throw new Error('repo is required')
  }

  const selected = Array.isArray(body?.plugins) ? body.plugins : undefined
  const carried = new Map((selected ?? []).map((item) => [item.name, item.carry === true]))

  let plugins = []
  if (settings.sets.plugins) {
    const scanned = await scanPlugins({ pluginManager: ctx.get('pluginManager'), profileDir })
    plugins = selected
      ? scanned.items.filter((item) => selected.some((pick) => pick.name === item.name))
      : scanned.items
    for (const item of plugins) {
      item.carry = carried.get(item.name) === true || item.kind !== 'registry'
    }
  }

  const configScan = settings.sets.config ? (await scanConfig(profileDir)).items : []
  const selectedConfig = Array.isArray(body?.config) ? new Set(body.config) : null
  const config = selectedConfig ? configScan.filter((item) => selectedConfig.has(item.relPath)) : configScan
  const folders = folderSpecs(body?.folders, settings.roots)

  const wanted = []
  if (settings.sets.plugins && plugins.length) wanted.push('plugins')
  if (settings.sets.config && config.length) wanted.push('config')
  if (settings.sets.files && folders.length) wanted.push('files')
  if (!wanted.length) throw new Error('没有选中任何要提交的内容')

  const groups = groupByTarget(settings, wanted)
  for (const group of groups) {
    if (!group.target.repo) throw new Error(`「${group.sets.join(' / ')}」还没有配置仓库`)
  }

  const results = []
  for (const group of groups) {
    const token = await getToken(ctx, group.target.platform)
    if (!token) throw new Error(`${group.target.platform} 的令牌未配置`)

    const payload = await collectPayload({
      plugins: group.sets.includes('plugins') ? plugins : [],
      config: group.sets.includes('config') ? config : [],
      folders: group.sets.includes('files') ? folders : [],
      limits: settings.limits,
    })

    const previous = await previousManifest(group.target, token)
    const manifest = buildManifest({
      platform: group.target.platform,
      branch: group.target.branch,
      plugins: payload.plugins,
      config: payload.config,
      files: payload.folders,
      revision: (Number(previous?.revision) || 0) + 1,
    })

    // A commit carries only the sets it was asked to carry, but the manifest is
    // one document describing all of them. Rebuilding it from this commit alone
    // would make the repository forget every set that was not part of it, so
    // the untouchable sets keep their previous entries verbatim.
    const preserved = carryOver(manifest, previous?.sets, group.sets)
    const manifestFile = manifestToFile(manifest)
    // Fingerprint of the index exactly as stored, so the machine that pulls can
    // prove it received this revision and not a neighbour of it.
    const indexSha = sha256(manifestFile.content)
    const files = [...payload.uploads, manifestFile]

    const uploaded = await uploadFiles({
      platform: group.target.platform,
      repo: group.target.repo,
      token,
      branch: group.target.branch,
      files,
      message: typeof body?.message === 'string' && body.message ? body.message : 'repot: sync',
    })

    const items = files.map((file) => ({ path: file.path, bytes: file.bytes }))
    const bytes = items.reduce((sum, item) => sum + item.bytes, 0)
    const log = await appendHistory(profileDir, {
      kind: 'upload',
      ...group.target,
      sets: group.sets,
      revision: manifest.revision,
      indexSha,
      commit: uploaded.commit ?? null,
      strategy: uploaded.strategy,
      totals: { files: items.length, bytes, deletions: uploaded.deletions ?? 0 },
      items,
      ...(preserved.length ? { preserved } : {}),
    })

    results.push({
      target: group.target,
      sets: group.sets,
      revision: manifest.revision,
      indexSha,
      commit: uploaded.commit ?? null,
      strategy: uploaded.strategy,
      files: items.length,
      bytes,
      manifest,
      preserved,
      log,
    })
  }

  return {
    groups: results,
    commit: results[0]?.commit ?? null,
    files: results.reduce((sum, item) => sum + item.files, 0),
    bytes: results.reduce((sum, item) => sum + item.bytes, 0),
    targets: resolvedTargets(settings),
  }
}

function emptyComparison() {
  return {
    plugins: { install: [], same: [], differ: [], extraLocal: [] },
    config: { same: [], differ: [], missingLocal: [], extraLocal: [] },
    files: { same: [], differ: [], unknown: [], extraLocal: [] },
  }
}

function mergeInto(bucket, part) {
  for (const key of Object.keys(bucket)) bucket[key].push(...(part?.[key] ?? []))
}

/**
 * Attach a per-file diff to each folder row.
 *
 * The remote side of the diff lives in `files/<id>/.repot-index.json`, one small
 * JSON per folder, so this costs one extra request per folder and no payload
 * download.
 */
async function attachFolderDiffs(result, local, base) {
  for (const row of [...(result.same ?? []), ...(result.differ ?? []), ...(result.unknown ?? [])]) {
    let index
    try {
      const hit = await getFileBuffer({ ...base, path: `files/${row.id}/.repot-index.json` })
      if (!hit.exists) continue
      index = JSON.parse(hit.buffer.toString('utf8'))
    } catch {
      continue
    }

    const remoteFiles = indexFiles(index)
    const mine = local.get(row.id)
    if (mine) {
      row.diff = diffFolder(remoteFiles, mine.files ?? [])
    } else {
      // Nothing here with that id: every remote file would be created.
      row.diff = {
        supported: true,
        added: remoteFiles.map((file) => ({ relPath: file.relPath, bytes: file.bytes })),
        changed: [],
        removed: [],
        counts: { added: remoteFiles.length, changed: 0, removed: 0 },
      }
    }
    row.remoteFiles = remoteFiles.length
  }
}

async function handlerCompare(ctx, body) {
  const { settings, profileDir } = await loadSettings(ctx)
  const wanted = ['plugins', 'config', 'files'].filter((set) => settings.sets[set])
  const groups = groupByTarget(settings, wanted)

  const localPlugins = settings.sets.plugins
    ? (await scanPlugins({ pluginManager: ctx.get('pluginManager'), profileDir })).items
    : []

  const localConfig = []
  if (settings.sets.config) {
    for (const item of (await scanConfig(profileDir)).items) {
      try {
        const content = await readFile(item.absPath)
        localConfig.push({ relPath: item.relPath, sha256: sha256(content), bytes: content.length })
      } catch {
        localConfig.push({ relPath: item.relPath, bytes: item.bytes })
      }
    }
  }

  const localFolders = []
  if (settings.sets.files) {
    for (const spec of folderSpecs(body?.folders, settings.roots)) {
      try {
        localFolders.push(await hashFolder({ id: spec.id, absPath: spec.absPath, limits: settings.limits }))
      } catch (error) {
        // A folder that vanished is not a comparison failure; the remote entry
        // simply has nothing local to be compared with.
        localFolders.push({ id: spec.id, missing: error?.message ?? String(error) })
      }
    }
  }

  const comparison = emptyComparison()
  const targets = {}
  const skipped = []
  let found = false

  for (const group of groups) {
    for (const set of group.sets) targets[set] = group.target
    if (!group.target.repo) {
      skipped.push(...group.sets)
      continue
    }
    const token = await getToken(ctx, group.target.platform)
    if (!token) throw new Error(`${group.target.platform} 的令牌未配置`)

    const remote = await readManifest({ ...group.target, token })
    if (!remote.exists) continue
    found = true

    if (group.sets.includes('plugins')) {
      mergeInto(comparison.plugins, comparePlugins(remote.manifest.sets?.plugins?.items, localPlugins))
    }
    if (group.sets.includes('config')) {
      mergeInto(comparison.config, compareConfig(remote.manifest.sets?.config?.items, localConfig))
    }
    if (group.sets.includes('files')) {
      const local = new Map(localFolders.filter((f) => !f.missing).map((f) => [f.id, f]))
      const result = compareFiles(remote.manifest.sets?.files?.items, [...local.values()])
      await attachFolderDiffs(result, local, { ...group.target, token })
      mergeInto(comparison.files, result)
    }
  }

  if (!found) return { exists: false, targets, skipped }
  return { exists: true, comparison, targets, skipped }
}

/** Fetch a list of repository paths into `Map<path, Buffer>`. */
async function fetchBuffers({ platform, repo, branch, token, paths }) {
  const out = new Map()
  for (const path of paths) {
    const hit = await getFileBuffer({ platform, repo, branch, token, path })
    if (!hit.exists) throw new Error(`远端缺少文件：${path}`)
    out.set(path, hit.buffer)
  }
  return out
}

/**
 * Apply remote content to this machine.
 *
 * Nothing here decides *where* to write — `applyFolder` re-runs the path
 * preflight internally, so a folder that would land somewhere unexpected is
 * refused even if the client asked for it.
 */
async function handlerApply(ctx, body) {
  const { settings, profileDir } = await loadSettings(ctx)
  if (body?.confirm !== true) throw new GuardError('confirm-required', '应用会写入本机文件，需要显式确认')

  const wanted = ['plugins', 'config', 'files'].filter((set) => settings.sets[set])
  const groups = groupByTarget(settings, wanted)
  for (const group of groups) {
    if (!group.target.repo) throw new Error(`「${group.sets.join(' / ')}」还没有配置仓库`)
  }

  const pickPlugins = new Set(Array.isArray(body?.plugins) ? body.plugins : [])
  const pickConfig = new Set(Array.isArray(body?.config) ? body.config : [])
  const pickFolders = new Set(Array.isArray(body?.folders) ? body.folders : [])

  const results = { plugins: [], config: [], folders: [], backupDir: null, restart: [], groups: [] }
  const logs = []
  let found = false
  // One stamp for the whole apply, so config files and folder files that were
  // replaced land in the same backup directory.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = join(profileDir, '.repot', 'backup')
  const backupDir = join(backupRoot, stamp)

  for (const group of groups) {
    const token = await getToken(ctx, group.target.platform)
    if (!token) throw new Error(`${group.target.platform} 的令牌未配置`)

    const base = { ...group.target, token }
    const remote = await readManifest(base)
    if (!remote.exists) continue
    found = true
    const manifest = remote.manifest
    const before = { plugins: results.plugins.length, config: results.config.length, folders: results.folders.length }

    if (group.sets.includes('files')) {
      for (const item of (manifest.sets?.files?.items ?? []).filter((entry) => pickFolders.has(entry.id))) {
        const prefix = folderPrefix(item.id)
        const indexHit = await getFileBuffer({ ...base, path: `${prefix}${FOLDER_INDEX_NAME}` })
        if (!indexHit.exists) {
          results.folders.push({ id: item.id, status: 'missing-payload' })
          continue
        }
        let index
        try {
          index = JSON.parse(indexHit.buffer.toString('utf8'))
        } catch {
          results.folders.push({ id: item.id, status: 'failed', reason: '索引文件损坏' })
          continue
        }
        const paths = (index.files ?? []).map((file) => prefix + file.relPath)
        const buffers = await fetchBuffers({ ...base, paths })
        const files = [...buffers.entries()].map(([path, content]) => ({ path, content }))
        results.folders.push(await applyFolder({ item, roots: settings.roots, files, backupDir: backupRoot, stamp }))
      }
    }

    if (group.sets.includes('config') && pickConfig.size) {
      const items = (manifest.sets?.config?.items ?? []).filter((entry) => pickConfig.has(entry.relPath))
      if (items.length) {
        const buffers = await fetchBuffers({ ...base, paths: items.map((entry) => `config/${entry.relPath}`) })
        const files = [...buffers.entries()].map(([path, content]) => ({ path, content }))
        const sourcePlugins = (manifest.sets?.plugins?.items ?? [])
          .filter((plugin) => plugin.kind === 'source' && plugin.dir)
          .map((plugin) => ({ name: plugin.name }))
        const applied = await applyConfig({ profileDir, items, files, sourcePlugins, backupDir: backupRoot, stamp })
        results.config = applied.results
        results.backupDir = applied.backupDir
      }
    }

    if (group.sets.includes('plugins') && pickPlugins.size) {
      const items = (manifest.sets?.plugins?.items ?? []).filter((plugin) => pickPlugins.has(plugin.name))
      if (items.length) {
        const paths = []
        for (const item of items) {
          if (item.tgz) paths.push(item.tgz)
          if (item.file) paths.push(item.file)
          if (item.kind === 'source' && item.dir) {
            for (const rel of item.entries ?? []) paths.push(`${item.dir}/${rel}`)
          }
        }
        const payloads = paths.length ? await fetchBuffers({ ...base, paths }) : new Map()
        const installed = await applyPlugins({
          pluginManager: ctx.get('pluginManager'),
          items,
          payloads,
          pluginsDir: join(profileDir, 'plugins'),
        })
        results.plugins.push(...installed)
        for (const result of installed) {
          if (result.status === 'installed-restart') results.restart.push(result.name)
        }
      }
    }

    results.groups.push({
      target: group.target,
      sets: group.sets,
      plugins: results.plugins.length - before.plugins,
      config: results.config.length - before.config,
      folders: results.folders.length - before.folders,
    })

    logs.push({
      kind: 'apply',
      ...group.target,
      sets: group.sets,
      revision: manifest.revision ?? null,
      indexSha: remote.text ? sha256(Buffer.from(remote.text, 'utf8')) : null,
      totals: {
        plugins: results.plugins.slice(before.plugins).filter((r) => String(r.status).startsWith('installed')).length,
        config: results.config.slice(before.config).filter((r) => r.status === 'applied').length,
        folders: results.folders.slice(before.folders).filter((r) => r.status === 'applied').length,
        skipped: results.folders.slice(before.folders).filter((r) => r.status !== 'applied').length,
        conflicts: results.folders
          .slice(before.folders)
          .reduce((sum, r) => sum + (r.conflicts?.length ?? 0) + (r.keptLocal?.length ?? 0), 0),
      },
      items: results.folders.slice(before.folders).map((r) => ({ path: r.target ?? r.id, status: r.status, bytes: r.bytes ?? 0 })),
    })
  }

  for (const entry of logs) await appendHistory(profileDir, entry).catch(() => {})

  // Report where the safety copy went even when only folders were restored.
  if (!results.backupDir && results.folders.some((folder) => folder.backedUp > 0)) results.backupDir = backupDir

  if (!found) throw new Error('远端还没有清单，请先在另一台机器上传')
  return results
}

// ------------------------------------------------------------ http bridge ---

const HANDLERS = {
  state: (ctx) => handlerState(ctx),
  settings: (ctx, body) => handlerSaveSettings(ctx, body),
  verify: (ctx, body) => handlerVerify(ctx, body),
  preflight: (ctx, body) => handlerPreflight(ctx, body),
  scan: (ctx, body) => handlerScan(ctx, body),
  upload: (ctx, body) => handlerUpload(ctx, body),
  compare: (ctx, body) => handlerCompare(ctx, body),
  apply: (ctx, body) => handlerApply(ctx, body),
  async history(ctx, body) {
    const { profileDir } = await loadSettings(ctx)
    const limit = Number(body?.limit) > 0 ? Math.min(200, Number(body.limit)) : 50
    return { entries: await readHistory(profileDir, limit) }
  },
  async 'token/save'(ctx, body) {
    if (!body?.token) throw new Error('empty token')
    const platform = body.platform === 'gitee' ? 'gitee' : 'github'
    await saveToken(ctx, platform, String(body.token))
    return { ok: true }
  },
  async 'token/clear'(ctx, body) {
    const platform = body?.platform === 'gitee' ? 'gitee' : 'github'
    await clearToken(ctx, platform)
    return { ok: true }
  },
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, payload) {
  if (res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

async function handleRequest(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST required' } })
    return
  }

  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const method = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : ''
  const handler = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : undefined
  if (typeof handler !== 'function') {
    writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
    return
  }

  try {
    const body = await readJsonBody(req)
    const value = await handler(ctx, body)
    writeJson(res, 200, { ok: true, value })
  } catch (error) {
    writeJson(res, 400, {
      ok: false,
      error: { code: error?.code ?? 'bad-request', message: error?.message ?? String(error) },
    })
  }
}
