/**
 * Restore the configuration set.
 *
 * `package.json` is the only file that cannot be copied verbatim: it carries
 * `file:` specs pointing at the *source* machine's absolute paths. Those are
 * rewritten to `./plugins/<name>` — a path relative to the profile, so the
 * result stops depending on drive letters or user names.
 *
 * Every overwritten file is copied into `.repot/backup/<stamp>/` first. The
 * broken case this prevents is a restore that half-applies a manifest and
 * leaves a profile nobody can boot.
 */
import { copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Where carried source plugins land on the target machine. */
export function sourcePluginSpec(name) {
  return `file:./plugins/${name}`
}

/**
 * Rewrite `file:` dependencies to profile-relative paths.
 *
 * A dependency whose target is not part of the carried set is **dropped** and
 * reported: leaving the old absolute path in place would make the next
 * `pnpm install` fail on a path that no longer exists.
 */
export function rewriteFileSpecs(text, sourcePlugins = []) {
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    throw new Error(`package.json 不是合法 JSON：${error.message}`)
  }

  const changes = []
  const dropped = []
  const deps = manifest.dependencies ?? {}

  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue

    const carried = sourcePlugins.find(
      (plugin) =>
        plugin.name === name ||
        spec.endsWith(`/${plugin.name}`) ||
        spec.endsWith(`\\${plugin.name}`) ||
        spec.endsWith(`/${plugin.name}.tgz`),
    )

    if (carried) {
      const next = sourcePluginSpec(carried.name)
      if (spec !== next) {
        deps[name] = next
        changes.push({ name, from: spec, to: next })
      }
    } else {
      delete deps[name]
      dropped.push({ name, from: spec })
    }
  }

  manifest.dependencies = deps
  return { text: `${JSON.stringify(manifest, null, 2)}\n`, changes, dropped }
}

export async function applyConfig({ profileDir, items, files, sourcePlugins = [], backupDir, stamp }) {
  const payloads = new Map((files ?? []).map((file) => [file.path, file.content]))
  const backupRoot = backupDir ?? join(profileDir, '.repot', 'backup')
  const stampDir = join(backupRoot, stamp ?? new Date().toISOString().replace(/[:.]/g, '-'))
  const results = []

  for (const item of items ?? []) {
    const payload = payloads.get(`config/${item.relPath}`)
    if (!payload) {
      results.push({ relPath: item.relPath, status: 'missing-payload' })
      continue
    }

    const target = join(profileDir, item.relPath)
    let backedUp = false
    try {
      await stat(target)
      const dest = join(stampDir, item.relPath)
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(target, dest)
      backedUp = true
    } catch {
      /* first apply on a fresh machine: nothing to back up */
    }

    let text = payload.toString('utf8')
    let changes = []
    let dropped = []
    if (item.relPath === 'package.json') {
      const rewritten = rewriteFileSpecs(text, sourcePlugins)
      text = rewritten.text
      changes = rewritten.changes
      dropped = rewritten.dropped
    }

    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.repot.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, target)

    results.push({ relPath: item.relPath, status: 'applied', backedUp, changes, dropped })
  }

  return { results, backupDir: stampDir }
}
