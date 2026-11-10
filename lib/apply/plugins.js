/**
 * Restore the plugin set.
 *
 * Three shapes, three specs — all of them accepted by `pluginManager`:
 *
 *   registry (no payload)  `installBundle('name@version', { saveExact: true })`
 *   carried tarball        write the blob to a temp file, then install it
 *   carried source tree    materialise under `<profile>/plugins/<name>`
 *
 * Dependency order comes from the manifest, because installing a plugin before
 * the plugin it depends on fails with a peer error that names neither.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { orderByDependencies } from '../scan/plugins.js'

const SOURCE_PREFIX = 'plugins/'

function mapApplication(result) {
  switch (result?.application) {
    case 'applied':
    case 'overridden':
      return 'installed'
    case 'restart-required':
      return 'installed-restart'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

/** Write every payload under `prefix` into `targetDir`, preserving layout. */
export async function materialize(payloads, prefix, targetDir) {
  let count = 0
  for (const [path, content] of payloads) {
    if (!path.startsWith(prefix)) continue
    const rel = path.slice(prefix.length)
    if (!rel) continue
    const abs = join(targetDir, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
    count += 1
  }
  return count
}

export async function applyPlugins({
  pluginManager,
  items = [],
  payloads = new Map(),
  pluginsDir,
  tempDir = tmpdir(),
}) {
  if (!pluginManager?.installBundle) {
    throw new Error('pluginManager 服务不可用，无法还原插件')
  }

  const ordered = orderByDependencies(items)
  const results = []

  for (const item of ordered) {
    const base = { name: item.name, version: item.version, kind: item.kind, mode: item.mode }

    try {
      let spec

      if (item.mode === 'registry') {
        spec = item.version && item.version !== '0.0.0' ? `${item.name}@${item.version}` : item.name
      } else if (item.tgz || item.file) {
        const path = item.tgz ?? item.file
        const content = payloads.get(path)
        if (!content) {
          results.push({ ...base, status: 'missing-payload', message: `远端缺少 ${path}` })
          continue
        }
        spec = join(tempDir, `repot-${randomUUID()}-${path.split('/').pop()}`)
        await writeFile(spec, content)
      } else if (item.dir && item.dir.startsWith(SOURCE_PREFIX)) {
        const targetDir = join(pluginsDir, item.name)
        const written = await materialize(payloads, `${item.dir}/`, targetDir)
        if (written === 0) {
          results.push({ ...base, status: 'missing-payload', message: `远端缺少 ${item.dir}` })
          continue
        }
        spec = targetDir
      } else {
        results.push({ ...base, status: 'unsupported', message: '清单条目的形态无法还原' })
        continue
      }

      const change = await pluginManager.installBundle(spec, { saveExact: true })
      const status = mapApplication(change)
      if (status === 'failed' && change?.error?.code === 'already-installed') {
        results.push({ ...base, status: 'skipped', message: '已安装' })
        continue
      }
      results.push({
        ...base,
        status,
        target: change?.target,
        message: change?.error?.diagnostic ?? change?.error?.code,
      })
    } catch (error) {
      results.push({ ...base, status: 'failed', message: error?.message ?? String(error) })
    }
  }

  return results
}
