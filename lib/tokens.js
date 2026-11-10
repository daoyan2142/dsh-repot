/**
 * PAT storage.
 *
 * Reference names changed with the rename. On first run the legacy refs are
 * copied once and the old values are left in place, so a rollback to
 * dsh-plugin-git-sync still finds its token.
 */
export const TOKEN_REF = Object.freeze({
  github: 'REPOT_GITHUB_TOKEN',
  gitee: 'REPOT_GITEE_TOKEN',
})

export const LEGACY_TOKEN_REF = Object.freeze({
  github: 'GIT_SYNC_GITHUB_TOKEN',
  gitee: 'GIT_SYNC_GITEE_TOKEN',
})

const PLATFORMS = ['github', 'gitee']

async function credentials(ctx) {
  return ctx?.get?.('credentials')
}

/** Whether a token is configured for this platform. */
export async function tokenPresence(ctx, platform) {
  const cred = await credentials(ctx)
  if (!cred) return false
  try {
    const info = await cred.describe(TOKEN_REF[platform])
    return Boolean(info?.configured)
  } catch {
    return false
  }
}

/** Resolve the token value (never returned over HTTP). */
export async function getToken(ctx, platform) {
  const cred = await credentials(ctx)
  if (!cred) return undefined
  try {
    const hit = await cred.resolve(TOKEN_REF[platform])
    return hit?.value
  } catch {
    return undefined
  }
}

export async function saveToken(ctx, platform, token) {
  const cred = await credentials(ctx)
  if (!cred) throw new Error('credentials service is unavailable')
  await cred.set(TOKEN_REF[platform], token)
}

export async function clearToken(ctx, platform) {
  const cred = await credentials(ctx)
  if (!cred) return
  try {
    await cred.unset(TOKEN_REF[platform])
  } catch {
    /* absent */
  }
}

/**
 * Copy `GIT_SYNC_*` values into `REPOT_*` once.
 * Returns `{ migrated: string[] }` — empty on every run after the first.
 */
export async function migrateTokens(ctx) {
  const cred = await credentials(ctx)
  const migrated = []
  if (!cred) return { migrated }

  for (const platform of PLATFORMS) {
    let newConfigured = false
    try {
      newConfigured = Boolean((await cred.describe(TOKEN_REF[platform]))?.configured)
    } catch {
      newConfigured = false
    }
    if (newConfigured) continue

    let legacyValue
    try {
      legacyValue = (await cred.resolve(LEGACY_TOKEN_REF[platform]))?.value
    } catch {
      legacyValue = undefined
    }
    if (!legacyValue) continue

    try {
      await cred.set(TOKEN_REF[platform], legacyValue)
      migrated.push(platform)
    } catch {
      /* a failed copy must not break startup */
    }
  }
  return { migrated }
}

/** Presence for both platforms at once. */
export async function tokenSummary(ctx) {
  return {
    github: await tokenPresence(ctx, 'github'),
    gitee: await tokenPresence(ctx, 'gitee'),
  }
}
