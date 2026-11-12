/**
 * The plugin set. Two install shapes behave nothing alike, so they are
 * classified separately rather than flattened into "a plugin":
 *
 *   registry — installed from npm/registry; carried as a `.tgz`, restored with
 *              `installBundle`
 *   source   — a `file:` directory (often a junction into a dev checkout);
 *              carried as a source tree, restored by re-linking, because
 *              packing it would silently freeze a live-edit workflow
 *   tarball  — a `file:` pointing at a `.tgz`; carried as-is
 *
 * Anything that appears in both lists is classified by its `file:` spec: the
 * install *intent* lives there, not in node_modules.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackageDir } from '../pack.js'
import { walk } from './walk.js'

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** This plugin's own name — never carried inside its own sync set. */
async function selfName() {
  try {
    const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))
    return manifest?.name
  } catch {
    return undefined
  }
}

/** Packages above this size are flagged so the UI can offer a reinstall instead. */
export const HEAVY_BYTES = 20 * 1024 * 1024

async function measure(dir) {
  try {
    const walked = await walk(dir)
    return { bytes: walked.totalBytes, fileCount: walked.files.length }
  } catch {
    return { bytes: 0, fileCount: 0 }
  }
}

/**
 * Local specs in the profile manifest → `Map<name, target>`.
 *
 * Both `file:` and `link:` point at a directory on this machine. A `link:` is
 * how a dev checkout is wired up (`dsh plugin add --link`), and it carries just
 * as badly as `file:` does: the target is an absolute path that means nothing
 * on the next machine. Treating only `file:` as local classified linked
 * plugins as registry installs, which then failed on a package npm never had.
 */
export async function readFileSpecs(profileDir) {
  if (!profileDir) return new Map()
  const manifest = await readJson(join(profileDir, 'package.json'))
  const deps = manifest?.dependencies ?? {}
  const out = new Map()
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string') continue
    if (spec.startsWith('file:')) out.set(name, spec.slice('file:'.length))
    else if (spec.startsWith('link:')) out.set(name, spec.slice('link:'.length))
  }
  return out
}

export async function scanPlugins({ pluginManager, profileDir } = {}) {
  const items = []
  const warnings = []
  const self = await selfName()

  const fileSpecs = await readFileSpecs(profileDir)
  const bundles = pluginManager?.listBundles ? await pluginManager.listBundles().catch(() => []) : []
  const installed = new Map((bundles ?? []).map((b) => [b.name, b]))

  // 1. Registry-installed third-party bundles.
  for (const bundle of bundles ?? []) {
    if (bundle.official || !bundle.installed) continue
    if (fileSpecs.has(bundle.name)) continue
    if (self && bundle.name === self) continue

    const dir = resolvePackageDir(bundle.name, profileDir)
    if (!dir) {
      warnings.push(`${bundle.name}: 找不到包目录，已跳过`)
      continue
    }
    const manifest = await readJson(join(dir, 'package.json'))
    const size = await measure(dir)
    items.push({
      name: bundle.name,
      version: bundle.version ?? manifest?.version ?? '0.0.0',
      kind: 'registry',
      dir,
      installed: true,
      heavy: size.bytes > HEAVY_BYTES,
      deps: Object.keys(manifest?.dependencies ?? {}),
      ...size,
    })
  }

  // 2. `file:` dependencies — source tree or tarball.
  for (const [name, target] of fileSpecs) {
    if (self && name === self) continue
    let real
    try {
      real = await realpath(target)
    } catch {
      warnings.push(`${name}: file: 目标不存在（${target}）`)
      continue
    }
    let info
    try {
      info = await stat(real)
    } catch {
      warnings.push(`${name}: 无法读取（${target}）`)
      continue
    }

    if (info.isFile()) {
      items.push({
        name,
        version: installed.get(name)?.version ?? '0.0.0',
        kind: 'tarball',
        file: real,
        installed: installed.has(name),
        bytes: info.size,
        fileCount: 1,
        deps: [],
      })
      continue
    }

    const manifest = await readJson(join(real, 'package.json'))
    if (!manifest) warnings.push(`${name}: 源码目录里没有 package.json`)
    const size = await measure(real)
    items.push({
      name,
      version: manifest?.version ?? installed.get(name)?.version ?? '0.0.0',
      kind: 'source',
      dir: real,
      installed: installed.has(name),
      deps: Object.keys(manifest?.dependencies ?? {}),
      ...size,
    })
  }

  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    items,
    warnings,
    bytes: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
  }
}

/**
 * Install order: a plugin that another one depends on must be applied first.
 * Cycles are tolerated — they simply fall back to discovery order.
 */
export function orderByDependencies(items) {
  const byName = new Map(items.map((item) => [item.name, item]))
  const placed = new Set()
  const out = []
  const visiting = new Set()

  function place(item) {
    if (!item || placed.has(item.name)) return
    if (visiting.has(item.name)) return
    visiting.add(item.name)
    for (const dep of item.deps ?? []) place(byName.get(dep))
    visiting.delete(item.name)
    placed.add(item.name)
    out.push(item)
  }

  for (const item of items) place(item)
  return out
}
