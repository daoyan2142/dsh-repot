/**
 * Dev report: run the three scanners against the live profile and print what
 * they see, plus how much `files` filtering saves on the biggest packages.
 * Usage: node scripts/scan-report.mjs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { scanConfig } from '../lib/scan/config.js'
import { scanFolder } from '../lib/scan/files.js'
import { scanPlugins } from '../lib/scan/plugins.js'
import { planPackage, packDirectory } from '../lib/pack.js'

const MB = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

const profile = process.env.DSH_PROFILE_DIR
if (!profile) {
  console.error('DSH_PROFILE_DIR is not set')
  process.exit(1)
}

console.log(`profile: ${profile}\n`)

const config = await scanConfig(profile)
console.log(`— config set (${config.items.length} files, ${config.bytes} B)`)
for (const item of config.items) console.log(`    ${item.relPath.padEnd(22)} ${String(item.bytes).padStart(7)} B`)
console.log(`    skipped: ${config.skipped.map((s) => `${s.relPath}(${s.reason})`).join(', ') || '—'}`)

const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
const bundles = (manifest?.dsh?.profile?.bundles ?? []).map((name) => ({
  name,
  official: name.startsWith('@deepseek-ai/'),
  installed: true,
}))
const plugins = await scanPlugins({
  pluginManager: { listBundles: async () => bundles },
  profileDir: profile,
})

console.log(`\n— plugin set (${plugins.items.length} items, ${MB(plugins.bytes)})`)
for (const item of plugins.items) {
  const where = item.kind === 'source' ? item.dir : item.kind === 'tarball' ? item.file : item.dir
  console.log(
    `    ${item.name.padEnd(42)} ${item.kind.padEnd(8)} ${String(item.fileCount).padStart(5)} f  ${MB(item.bytes).padStart(9)}  ${where}`,
  )
}
if (plugins.warnings.length) console.log(`    warnings: ${plugins.warnings.join('; ')}`)

// How much does honouring `files` actually save on the heaviest packages?
console.log('\n— tarball savings (files field vs whole tree)')
const heavy = plugins.items
  .filter((i) => i.kind === 'registry' && i.bytes > 4 * 1024 * 1024)
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 4)
for (const item of heavy) {
  const plan = await planPackage(item.dir)
  const tgz = await packDirectory(item.dir)
  console.log(
    `    ${item.name.padEnd(34)} raw ${MB(plan.totalBytes).padStart(9)}  →  ${String(plan.files.length).padStart(4)} f  tgz ${MB(tgz.length).padStart(9)}`,
  )
}

// Extra folders to measure: pass them on the command line.
const extraFolders = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
if (!extraFolders.length) console.log('\n— folder set: pass one or more directories to measure them')
for (const folder of extraFolders) {
  const result = await scanFolder(folder, { maxFileMB: 10, maxSetMB: 500 })
  console.log(
    `    ${folder.padEnd(28)} ${String(result.fileCount).padStart(5)} f  ${MB(result.bytes).padStart(9)}  git=${result.gitManaged} selectable=${result.selectable}${result.error ? ' error=' + result.error : ''}`,
  )
}
