/**
 * Git-host REST abstraction (GitHub / Gitee). Pure fetch, no `git` binary and
 * no token written to `.git/config`. The caller passes the PAT in memory.
 *
 * Carried over from dsh-plugin-git-sync; the only change is the commit message
 * prefix `repot:`. Contents API is the fallback path — bulk uploads go through
 * `lib/remote/trees.js`.
 */

const PROVIDERS = {
  github: {
    base: 'https://api.github.com',
    headers(token) {
      return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    },
    authQuery: false,
  },
  gitee: {
    base: 'https://gitee.com/api/v5',
    headers(token) {
      return { Authorization: `token ${token}` }
    },
    authQuery: true,
  },
}

/** Infer the platform from a repository URL, when the host is recognizable. */
export function platformFromRepo(repo) {
  const s = String(repo || '')
  if (/gitee\.com/i.test(s)) return 'gitee'
  if (/github\.com/i.test(s)) return 'github'
  return undefined
}

export function providerFor(platform) {
  const p = PROVIDERS[platform]
  if (!p) throw new Error(`unsupported platform: ${platform}`)
  return p
}

/**
 * Accept `owner/repo`, a repository URL (`https://host/owner/repo(.git)`),
 * `ssh://host/owner/repo.git`, or `git@host:owner/repo.git`, and return the
 * two segments the REST API needs.
 */
export function splitRepo(repo) {
  const raw = String(repo || '').trim()
  if (!raw) throw new Error('repo is required')
  const s = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^git@[^:]+:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length === 2) return { owner: parts[0], name: parts[1] }
  if (parts.length === 3) return { owner: parts[1], name: parts[2] }
  throw new Error(`repo must be "owner/repo" or a repository URL, got "${raw}"`)
}

function withAuth(p, url, token) {
  if (!p.authQuery) return url
  const u = new URL(url)
  u.searchParams.set('access_token', token)
  return u.toString()
}

function encodePath(path) {
  return String(path)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

async function readBody(res) {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

/** Confirm the repo is reachable and the PAT is accepted. */
export async function verifyRepo({ platform, base, repo, token, signal }) {
  const p = providerFor(platform)
  const root = base ?? p.base
  const { owner, name } = splitRepo(repo)
  const url = withAuth(p, `${root}/repos/${owner}/${name}`, token)
  const res = await fetch(url, { headers: p.headers(token), signal })
  const body = await readBody(res)
  if (!res.ok) {
    return { ok: false, status: res.status, message: body?.message ?? `HTTP ${res.status}` }
  }
  return {
    ok: true,
    status: res.status,
    name: body?.full_name ?? body?.name ?? `${owner}/${name}`,
    defaultBranch: body?.default_branch ?? 'main',
    private: body?.private ?? null,
    permissions: body?.permissions ?? null,
  }
}

/**
 * Raw metadata for one file: base64 content (when inline), a download URL for
 * large files, and the current blob sha. `exists:false` on 404.
 */
export async function getFileRaw({ platform, base, repo, branch, token, path, signal }) {
  const p = providerFor(platform)
  const root = base ?? p.base
  const { owner, name } = splitRepo(repo)
  const url = withAuth(
    p,
    `${root}/repos/${owner}/${name}/contents/${encodePath(path)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`,
    token,
  )
  const res = await fetch(url, { headers: p.headers(token), signal })
  if (res.status === 404) return { status: 404, exists: false }
  const body = await readBody(res)
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`)
  // An empty repo (or a directory listing) can answer 200 without a blob sha;
  // treat that as "does not exist" so callers create rather than update.
  const sha = body && typeof body === 'object' && !Array.isArray(body) ? body.sha : undefined
  if (!sha) return { status: res.status, exists: false }
  return {
    status: res.status,
    exists: true,
    sha,
    contentBase64: typeof body.content === 'string' ? body.content.replace(/\n/g, '') : undefined,
    downloadUrl: body.download_url ?? undefined,
  }
}

/** Decode a file to a Buffer (handles the >1MB download_url fallback). */
export async function getFileBuffer(args) {
  const raw = await getFileRaw(args)
  if (!raw.exists) return { exists: false }
  if (raw.contentBase64 !== undefined) {
    return { exists: true, sha: raw.sha, buffer: Buffer.from(raw.contentBase64, 'base64') }
  }
  if (raw.downloadUrl) {
    const res = await fetch(raw.downloadUrl, {
      headers: providerFor(args.platform).headers(args.token),
      signal: args.signal,
    })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    return { exists: true, sha: raw.sha, buffer: Buffer.from(await res.arrayBuffer()) }
  }
  throw new Error(`no content for ${args.path}`)
}

/** Decode one file to text (undefined when it does not exist). */
export async function getFileText(args) {
  const raw = await getFileRaw(args)
  if (!raw.exists) return { exists: false }
  if (raw.contentBase64 !== undefined) {
    return { exists: true, sha: raw.sha, text: Buffer.from(raw.contentBase64, 'base64').toString('utf8') }
  }
  const buf = await getFileBuffer(args)
  return { exists: true, sha: raw.sha, text: buf.buffer.toString('utf8') }
}

/** Create or update one file from a base64 payload. Returns the new blob sha. */
export async function putFile({ platform, base, repo, branch, token, path, contentBase64, message, signal }) {
  const p = providerFor(platform)
  const root = base ?? p.base
  const { owner, name } = splitRepo(repo)
  const existing = await getFileRaw({ platform, base, repo, branch, token, path, signal }).catch(() => ({
    exists: false,
  }))
  const url = withAuth(p, `${root}/repos/${owner}/${name}/contents/${encodePath(path)}`, token)
  const payload = {
    message: message ?? `repot: update ${path}`,
    content: contentBase64,
    ...(branch ? { branch } : {}),
    ...(existing?.sha ? { sha: existing.sha } : {}),
  }
  const res = await fetch(url, {
    method: existing?.sha ? 'PUT' : 'POST',
    headers: { ...p.headers(token), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const body = await readBody(res)
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`)
  return { status: res.status, sha: body?.content?.sha ?? body?.sha }
}
