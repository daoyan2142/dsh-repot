/**
 * The configuration set: the four files that describe *how this profile is
 * wired*, and nothing that can be regenerated.
 *
 * `cordis.yml` is a generated `[]` root and is deliberately excluded — copying
 * it would overwrite whatever the target machine composes from its bundles.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Carried verbatim. */
export const CONFIG_FILES = ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

/** Present in the profile but never carried. */
export const GENERATED_FILES = ['cordis.yml']

export async function scanConfig(profileDir) {
  const items = []
  const skipped = []

  for (const relPath of CONFIG_FILES) {
    const absPath = join(profileDir, relPath)
    try {
      const info = await stat(absPath)
      items.push({ relPath, absPath, bytes: info.size, mtimeMs: Math.round(info.mtimeMs) })
    } catch {
      skipped.push({ relPath, reason: 'missing' })
    }
  }

  for (const relPath of GENERATED_FILES) skipped.push({ relPath, reason: 'generated' })

  return {
    items,
    skipped,
    bytes: items.reduce((sum, item) => sum + item.bytes, 0),
  }
}
