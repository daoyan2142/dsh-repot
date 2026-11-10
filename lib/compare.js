/**
 * Comparison between a remote manifest and what this machine actually has.
 *
 * Pure: takes plain objects, returns classification. No filesystem, no
 * network — the caller has already gathered the local side.
 */

/** Plugins: identity is the name; sameness is version + install shape. */
export function comparePlugins(remoteItems = [], localItems = []) {
  const local = new Map(localItems.map((item) => [item.name, item]))
  const install = []
  const same = []
  const differ = []

  for (const remote of remoteItems) {
    const mine = local.get(remote.name)
    if (!mine) {
      install.push({
        name: remote.name,
        version: remote.version,
        kind: remote.kind,
        mode: remote.mode,
        tgz: remote.tgz,
        dir: remote.dir,
        file: remote.file,
        sha256: remote.sha256,
        bytes: remote.bytes,
      })
      continue
    }
    local.delete(remote.name)
    const sameVersion = String(remote.version ?? '') === String(mine.version ?? '')
    const sameKind = String(remote.kind ?? 'registry') === String(mine.kind ?? 'registry')
    if (sameVersion && sameKind) {
      same.push({ name: remote.name, version: remote.version, kind: remote.kind })
    } else {
      differ.push({
        name: remote.name,
        remoteVersion: remote.version,
        localVersion: mine.version,
        remoteKind: remote.kind,
        localKind: mine.kind,
        reason: !sameVersion ? 'version' : 'kind',
      })
    }
  }

  const extraLocal = [...local.values()].map((item) => ({
    name: item.name,
    version: item.version,
    kind: item.kind,
  }))

  return { install, same, differ, extraLocal }
}

/** Config: identity is the profile-relative path; sameness is the hash. */
export function compareConfig(remoteItems = [], localItems = []) {
  const local = new Map(localItems.map((item) => [item.relPath, item]))
  const same = []
  const differ = []
  const missingLocal = []

  for (const remote of remoteItems) {
    const mine = local.get(remote.relPath)
    if (!mine) {
      missingLocal.push({ relPath: remote.relPath, bytes: remote.bytes })
      continue
    }
    local.delete(remote.relPath)
    if (remote.sha256 && mine.sha256) {
      if (remote.sha256 === mine.sha256) same.push({ relPath: remote.relPath })
      else differ.push({ relPath: remote.relPath, remote: remote.sha256.slice(0, 8), local: mine.sha256.slice(0, 8) })
    } else {
      differ.push({ relPath: remote.relPath, reason: 'no-hash' })
    }
  }

  const extraLocal = [...local.values()].map((item) => ({ relPath: item.relPath, bytes: item.bytes }))
  return { same, differ, missingLocal, extraLocal }
}

/** Folders: identity is the set id; sameness is the tree hash. */
export function compareFiles(remoteItems = [], localItems = []) {
  const local = new Map(localItems.map((item) => [item.id, item]))
  const same = []
  const differ = []
  const unknown = []

  for (const remote of remoteItems) {
    const mine = local.get(remote.id)
    if (!mine) {
      unknown.push({
        id: remote.id,
        absPath: remote.absPath,
        rootId: remote.rootId,
        relPath: remote.relPath,
        fileCount: remote.fileCount,
        bytes: remote.bytes,
      })
      continue
    }
    local.delete(remote.id)
    if (remote.sha256 && mine.sha256 && remote.sha256 === mine.sha256) same.push({ id: remote.id })
    else differ.push({ id: remote.id, remote: remote.sha256, local: mine.sha256 })
  }

  const extraLocal = [...local.values()].map((item) => ({ id: item.id, bytes: item.bytes }))
  return { same, differ, unknown, extraLocal }
}

/** One line the UI can show without digging into the three results. */
export function summarize(comparison = {}) {
  const parts = []
  for (const key of ['plugins', 'config', 'files']) {
    const set = comparison[key]
    if (!set) continue
    const counts = [
      ['install', set.install?.length],
      ['unknown', set.unknown?.length],
      ['missingLocal', set.missingLocal?.length],
      ['differ', set.differ?.length],
      ['same', set.same?.length],
      ['extraLocal', set.extraLocal?.length],
    ]
      .filter(([, n]) => typeof n === 'number' && n > 0)
      .map(([name, n]) => `${name} ${n}`)
    if (counts.length) parts.push(`${key}: ${counts.join(' · ')}`)
  }
  return parts.join('\n')
}
