/**
 * Manifest, schema version 2.
 *
 * One document describes everything the repository carries, so a second
 * machine can decide what to apply without downloading a single payload:
 *
 *   plugins — name/version/kind, and where the payload lives if there is one
 *   config  — the four profile files, by hash
 *   files   — folder snapshots, by id and hash, with the path anchor
 *
 * `mode: 'registry'` means "no payload is stored; reinstall name@version".
 * That is what keeps a 84 MB plugin set down to a few hundred bytes whenever
 * the registry still serves the package.
 */
import { createHash } from 'node:crypto'
import { getFileText } from './git.js'

export const MANIFEST_PATH = 'sync/manifest.json'
export const SCHEMA_VERSION = 2

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Hash a list of `{ path, content }` into a stable hex digest. */
export function sha256OfFiles(files) {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * @param {object} input
 * @param {string} input.platform
 * @param {string} input.branch
 * @param {Array} [input.plugins]
 * @param {Array} [input.config]
 * @param {Array} [input.files]
 * @param {number} [input.revision] per-repository counter, bumped on every commit
 */
export function buildManifest({ platform, branch, plugins = [], config = [], files = [], generatedAt, revision } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: 'dsh-repot',
    generatedAt: generatedAt ?? new Date().toISOString(),
    // Content hashes identify *what* is in the index; the revision says *which
    // version* of it this is, because a folder has no version number of its own.
    revision: Number.isFinite(revision) && revision > 0 ? Math.floor(revision) : 1,
    platform,
    branch,
    sets: {
      plugins: {
        items: plugins.map((item) => ({
          name: item.name,
          version: item.version ?? '0.0.0',
          kind: item.kind ?? 'registry',
          mode: item.mode ?? (item.kind === 'registry' ? 'registry' : 'carry'),
          ...(item.tgz ? { tgz: item.tgz } : {}),
          ...(item.dir ? { dir: item.dir } : {}),
          ...(item.file ? { file: item.file } : {}),
          ...(item.sha256 ? { sha256: item.sha256 } : {}),
          ...(item.bytes ? { bytes: item.bytes } : {}),
          ...(item.linkSpec ? { linkSpec: item.linkSpec } : {}),
          ...(item.entries ? { entries: item.entries } : {}),
          deps: item.deps ?? [],
        })),
      },
      config: {
        items: config.map((item) => ({
          relPath: item.relPath,
          sha256: item.sha256,
          bytes: item.bytes ?? 0,
        })),
      },
      files: {
        items: files.map((item) => ({
          id: item.id,
          absPath: item.absPath ?? null,
          rootId: item.rootId ?? null,
          relPath: item.relPath ?? null,
          sha256: item.sha256 ?? null,
          fileCount: item.fileCount ?? 0,
          bytes: item.bytes ?? 0,
        })),
      },
    },
  }
}

/** The manifest itself, as an uploadable file. */
export function manifestToFile(manifest) {
  return {
    path: MANIFEST_PATH,
    content: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
  }
}

export async function readManifest({ platform, repo, branch, token }) {
  const hit = await getFileText({ platform, repo, branch, token, path: MANIFEST_PATH })
  if (!hit.exists) return { exists: false }
  let manifest
  try {
    manifest = JSON.parse(hit.text)
  } catch (error) {
    throw new Error(`远端清单不是合法 JSON：${error.message}`)
  }
  if (manifest?.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`远端清单版本 ${manifest?.schemaVersion ?? '(无)'} 与插件期望的 ${SCHEMA_VERSION} 不一致`)
  }
  // Manifests written before 0.1.4 still list the lockfile. It is machine
  // specific, so readers ignore it instead of restoring a foreign resolution.
  const configItems = manifest?.sets?.config?.items
  if (Array.isArray(configItems)) {
    manifest.sets.config.items = configItems.filter((item) => item?.relPath !== 'pnpm-lock.yaml')
  }
  return { exists: true, manifest, sha: hit.sha, text: hit.text }
}
