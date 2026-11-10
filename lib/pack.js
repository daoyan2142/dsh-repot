/**
 * Dependency-free npm-compatible tarball writer + package resolution helpers.
 *
 * Why hand-rolled: DSH plugins must not add runtime dependencies, and shelling
 * out to `npm pack` is not portable inside the Host sandbox. This module emits
 * a standard ustar `.tgz` with the npm `package/` prefix that pnpm/npm accept
 * on `installBundle`.
 *
 * Two fixes over the dsh-plugin-git-sync version, both of which change what
 * ends up in the tarball:
 *   - `package.json#files` is honoured, so a published package ships what it
 *     says it ships instead of its whole repository (better-sidebar is 19 MB
 *     unpacked, dsh-boot-suite 54 MB — mostly source and docs)
 *   - the root is realpath'd first, so a junction-installed plugin packs its
 *     real content rather than an empty directory
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { DEFAULT_SKIP_DIRS, walk } from './scan/walk.js'

export const SKIP_DIRS = DEFAULT_SKIP_DIRS
export const MAX_PACKAGE_BYTES = 100 * 1024 * 1024

const requireFromHere = createRequire(import.meta.url)

/** Files npm always includes regardless of `files`. */
const ALWAYS_INCLUDE = [/^package\.json$/i, /^readme(\.[a-z0-9]+)?$/i, /^licen[cs]e(\.[a-z0-9]+)?$/i, /^icon\.svg$/i]

/**
 * The profile's node_modules directory, where every profile-installed bundle
 * lives (symlinks included). Falls back to undefined when the Harness was
 * booted without a profile.
 */
export function profileNodeModules(profileDir) {
  const dir = profileDir ?? process.env.DSH_PROFILE_DIR
  return dir ? join(dir, 'node_modules') : undefined
}

/** Walk up from a resolved file until the directory that holds package.json. */
function packageDirOf(file) {
  let dir = dirname(file)
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Resolve the on-disk directory of an installed package by name.
 * Checks `<profileDir>/node_modules/<name>` first (robust for every install
 * shape), then node resolution through the package main export.
 */
export function resolvePackageDir(name, profileDir) {
  const nm = profileNodeModules(profileDir)
  if (nm) {
    const dir = join(nm, name)
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  try {
    return packageDirOf(requireFromHere.resolve(name))
  } catch {
    return undefined
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** npm-style glob → RegExp. Supports `*`, `**`, `?` and literal paths. */
export function globToRegExp(pattern) {
  const p = String(pattern)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  if (!/[*?]/.test(p)) return new RegExp(`^${escapeRegExp(p)}(/|$)`)
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*' && p[i + 1] === '*') {
      i++
      if (p[i + 1] === '/') {
        i++
        out += '(?:.*/)?'
      } else {
        out += '.*'
      }
    } else if (ch === '*') {
      out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += escapeRegExp(ch)
    }
  }
  return new RegExp(`^${out}$`)
}

/** Normalize a `files` pattern to forward slashes without a trailing slash. */
function normalizePattern(pattern) {
  return String(pattern)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

/**
 * Should the walker descend into directory `rel`?
 *
 * A directory is worth descending when any pattern could still match something
 * beneath it — which is true when the pattern points inside it, when it points
 * at an ancestor of it, or when it starts with `**`.
 */
function couldContain(rel, patterns) {
  for (const raw of patterns) {
    const p = normalizePattern(raw)
    if (p.startsWith('**')) return true
    if (p === rel) return true
    if (p.startsWith(`${rel}/`)) return true
    if (rel.startsWith(`${p}/`)) return true
    const globAt = p.search(/[*?]/)
    const prefix = globAt === -1 ? p : p.slice(0, globAt)
    if (prefix && (rel.startsWith(prefix) || prefix.startsWith(`${rel}/`))) return true
  }
  return false
}

/**
 * Build the inclusion predicate for a package. With no `files` field the whole
 * tree is included (minus the standard skips).
 */
export function compileFilesFilter(files) {
  const patterns = Array.isArray(files) && files.length ? files : undefined
  if (!patterns) {
    return (rel) => !/\.tgz$/i.test(rel)
  }
  const matchers = patterns.map(globToRegExp)
  return (rel, isDir) => {
    if (/\.tgz$/i.test(rel)) return false
    if (ALWAYS_INCLUDE.some((re) => re.test(rel))) return true
    if (isDir) return couldContain(rel, patterns)
    if (matchers.some((re) => re.test(rel))) return true
    // A pattern naming a directory also selects everything beneath it.
    return patterns.some((raw) => {
      const p = normalizePattern(raw)
      return rel === p || rel.startsWith(`${p}/`)
    })
  }
}

function octal(value, width) {
  return value.toString(8).padStart(width, '0')
}

/**
 * Split a path into tar name (<=100 bytes) and prefix (<=155 bytes).
 * Splits on the last '/' so both halves fit.
 */
function splitTarName(full) {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: '' }
  for (let i = full.length - 1; i > 0; i--) {
    if (full[i] !== '/') continue
    const prefix = full.slice(0, i)
    const name = full.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix }
    }
  }
  throw new Error(`tar path too long: ${full}`)
}

/** Build one 512-byte ustar header for a regular file. */
function tarHeader(fullPath, size, mtime) {
  const { name, prefix } = splitTarName(fullPath)
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write(octal(0o644, 7) + '\0', 100) // mode
  header.write(octal(0, 7) + '\0', 108) // uid
  header.write(octal(0, 7) + '\0', 116) // gid
  header.write(octal(size, 11) + '\0', 124) // size
  header.write(octal(mtime >>> 0, 11) + '\0', 136) // mtime
  header.write('        ', 148) // checksum placeholder
  header.write('0', 156) // typeflag: regular file
  header.write('ustar\0', 257) // magic
  header.write('00', 263) // version
  header.write(prefix, 345, 'utf8') // ustar prefix

  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]
  header.write(octal(sum, 6) + '\0 ', 148)
  return header
}

/** Phase 1 of packing: what would go in, and how big is it. */
export async function planPackage(root, options = {}) {
  const realRoot = await realpath(root)
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(realRoot, 'package.json'), 'utf8'))
  } catch {
    manifest = undefined
  }
  const include = compileFilesFilter(manifest?.files)
  const walked = await walk(realRoot, {
    ignore: (rel, isDir) => !include(rel, isDir),
    maxTotalBytes: options.maxTotalBytes ?? MAX_PACKAGE_BYTES,
  })
  return { root: realRoot, manifest, include, ...walked }
}

/**
 * Pack a directory into an npm-compatible `.tgz` Buffer.
 * Every entry is prefixed with `package/` exactly like `npm pack`.
 */
export async function packDirectory(root, options = {}) {
  const plan = await planPackage(root, options)
  if (plan.truncated || plan.totalBytes > (options.maxTotalBytes ?? MAX_PACKAGE_BYTES)) {
    const limit = Math.round((options.maxTotalBytes ?? MAX_PACKAGE_BYTES) / 1024 / 1024)
    throw new Error(`包体积超过上限 ${limit}MB：${plan.root}`)
  }

  const chunks = []
  for (const file of plan.files) {
    let info
    try {
      info = await stat(file.abs)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const data = await readFile(file.abs)
    chunks.push(tarHeader(`package/${file.rel}`, data.length, Math.floor(info.mtimeMs / 1000)))
    chunks.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024)) // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(chunks))
}

/** Pack a package by name (resolved through node_modules) into a `.tgz` Buffer. */
export async function packPackage(name, profileDir) {
  const dir = resolvePackageDir(name, profileDir)
  if (!dir) throw new Error(`cannot resolve package directory for ${name}`)
  return { dir, tgz: await packDirectory(dir) }
}
