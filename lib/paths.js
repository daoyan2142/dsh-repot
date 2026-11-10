/**
 * Locate the active DSH profile directory.
 *
 * `DSH_PROFILE_DIR` is set by the Host for every plugin process, so it is the
 * normal answer. The other two branches exist for contexts that boot a profile
 * without exporting it (tests, CLI tooling).
 */
import { dirname, join } from 'node:path'

/** Resolve the profile directory, or throw when it cannot be located. */
export async function profileDirectory(ctx) {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR

  const settings = ctx?.get?.('settings')
  if (settings?.prepareDocument) {
    try {
      const patch = await settings.prepareDocument()
      if (patch) return dirname(patch)
    } catch {
      /* fall through to the home-directory guess */
    }
  }

  const home = process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME
  if (home) return join(home, '.dsh', 'profiles', 'desktop')
  throw new Error('cannot locate the DSH profile directory')
}
