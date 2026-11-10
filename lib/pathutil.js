/**
 * Pure path predicates shared by settings validation and the write guard.
 * No filesystem access — `guard.js` layers the realpath checks on top.
 *
 * Windows comparisons are case-insensitive and separator-insensitive; POSIX
 * comparisons are exact. Nothing here decides that a write is legal — that is
 * `guard.js`'s job — these are the building blocks.
 */
import { resolve, sep } from 'node:path'

const CASE_INSENSITIVE = process.platform === 'win32'

/** A bare drive root — `C:` / `C:\` / `C:/`. Never a valid sync root. */
export function isDriveRoot(p) {
  return /^[a-zA-Z]:[\\/]?$/.test(String(p ?? ''))
}

/** Resolve to an absolute path and fold case where the platform does. */
export function normalizeForCompare(p) {
  const abs = resolve(String(p ?? ''))
  const trimmed = abs.length > 1 && (abs.endsWith(sep) || abs.endsWith('/')) ? abs.slice(0, -1) : abs
  return CASE_INSENSITIVE ? trimmed.toLowerCase() : trimmed
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(child, parent) {
  const c = normalizeForCompare(child)
  const p = normalizeForCompare(parent)
  if (!c || !p) return false
  if (c === p) return true
  return c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** True when `child` lives strictly underneath `parent`. */
export function isStrictlyInside(child, parent) {
  return isInside(child, parent) && normalizeForCompare(child) !== normalizeForCompare(parent)
}

/** Split a project-relative path into safe segments (rejects `..` and drives). */
export function safeRelSegments(relPath) {
  const raw = String(relPath ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (!raw) return []
  if (/^[a-zA-Z]:/.test(raw)) return null
  const out = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') return null
    out.push(part)
  }
  return out
}
