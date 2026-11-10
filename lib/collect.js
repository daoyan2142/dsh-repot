/**
 * Turn scanned items into (a) the bytes that must be uploaded and (b) the
 * manifest entries that describe them.
 *
 * The rule that keeps uploads small: a registry package whose version the
 * registry still serves is described as `name@version` with **no payload**.
 * Only things that cannot be re-fetched are carried as bytes.
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { packDirectory } from './pack.js'
import { walk } from './scan/walk.js'
import { sha256, sha256OfFiles } from './manifest.js'

/** Filesystem-safe tarball name for a (possibly scoped) package. */
export function tgzName(name, version) {
  const flat = String(name).replace(/^@/, '').replace(/\//g, '__')
  return `${flat}-${version ?? '0.0.0'}.tgz`
}

async function readAll(mapped) {
  const out = []
  for (const entry of mapped) {
    const content = await readFile(entry.abs)
    out.push({ path: entry.path, content, bytes: content.length })
  }
  return out
}

/**
 * @param {object} input
 * @param {Array} [input.plugins] scanned plugin items; `carry: true` forces a payload
 * @param {Array} [input.config]  scanned config items (need `absPath`)
 * @param {Array} [input.folders] `{ id, absPath, rootId, relPath }`
 */
export async function collectPayload({ plugins = [], config = [], folders = [], limits = {} } = {}) {
  const uploads = []
  const pluginEntries = []
  const configEntries = []
  const folderEntries = []

  for (const item of plugins) {
    const carry = item.carry === true || item.kind !== 'registry'

    if (!carry) {
      pluginEntries.push({
        name: item.name,
        version: item.version,
        kind: 'registry',
        mode: 'registry',
        deps: item.deps ?? [],
      })
      continue
    }

    if (item.kind === 'source') {
      const walked = await walk(item.dir, { maxTotalBytes: limits.maxSetMB ? limits.maxSetMB * 1024 * 1024 : undefined })
      const files = await readAll(walked.files.map((f) => ({ path: `plugins/${item.name}/${f.rel}`, abs: f.abs })))
      uploads.push(...files)
      pluginEntries.push({
        name: item.name,
        version: item.version,
        kind: 'source',
        mode: 'carry',
        dir: `plugins/${item.name}`,
        sha256: sha256OfFiles(files),
        bytes: files.reduce((sum, f) => sum + f.bytes, 0),
        linkSpec: item.linkSpec,
        deps: item.deps ?? [],
        // The restoring side needs the file list; a source plugin is small
        // enough to describe inline instead of shipping a separate index.
        entries: files.map((f) => f.path.slice(`plugins/${item.name}/`.length)),
      })
      continue
    }

    if (item.kind === 'tarball') {
      const content = await readFile(item.file)
      const path = `packages/${basename(item.file)}`
      uploads.push({ path, content, bytes: content.length })
      pluginEntries.push({
        name: item.name,
        version: item.version,
        kind: 'tarball',
        mode: 'carry',
        file: path,
        sha256: sha256(content),
        bytes: content.length,
        deps: item.deps ?? [],
      })
      continue
    }

    const tgz = await packDirectory(item.dir)
    const path = `packages/${tgzName(item.name, item.version)}`
    uploads.push({ path, content: tgz, bytes: tgz.length })
    pluginEntries.push({
      name: item.name,
      version: item.version,
      kind: 'registry',
      mode: 'carry',
      tgz: path,
      sha256: sha256(tgz),
      bytes: tgz.length,
      deps: item.deps ?? [],
    })
  }

  for (const item of config) {
    const content = await readFile(item.absPath)
    uploads.push({ path: `config/${item.relPath}`, content, bytes: content.length })
    configEntries.push({
      relPath: item.relPath,
      sha256: sha256(content),
      bytes: content.length,
    })
  }

  for (const folder of folders) {
    const walked = await walk(folder.absPath, {
      maxFileBytes: limits.maxFileMB ? limits.maxFileMB * 1024 * 1024 : undefined,
      maxTotalBytes: limits.maxSetMB ? limits.maxSetMB * 1024 * 1024 : undefined,
    })
    const files = await readAll(walked.files.map((f) => ({ path: `files/${folder.id}/${f.rel}`, abs: f.abs })))
    const digest = sha256OfFiles(files)

    // A per-folder index keeps the manifest small while still telling the
    // restoring side exactly which paths to fetch. It is written after the
    // digest so it never changes the folder's identity.
    const index = {
      id: folder.id,
      sha256: digest,
      files: files.map((f) => ({
        relPath: f.path.slice(`files/${folder.id}/`.length),
        bytes: f.bytes,
        // Per-file hash: the only thing that lets the other machine say *which*
        // file changed, instead of "the whole folder is different".
        sha256: sha256(f.content),
      })),
    }
    const indexContent = Buffer.from(JSON.stringify(index, null, 2), 'utf8')
    uploads.push({ path: `files/${folder.id}/.repot-index.json`, content: indexContent, bytes: indexContent.length })

    uploads.push(...files)
    folderEntries.push({
      id: folder.id,
      absPath: folder.absPath,
      rootId: folder.rootId,
      relPath: folder.relPath,
      sha256: digest,
      fileCount: files.length,
      bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      truncated: walked.truncated,
      skipped: walked.skipped.length,
    })
  }

  return {
    uploads,
    plugins: pluginEntries,
    config: configEntries,
    folders: folderEntries,
  }
}
