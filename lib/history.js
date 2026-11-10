/**
 * Append-only operation log at `<profile>/.repot/history.jsonl`.
 *
 * One line per upload or apply, newest last in the file and newest first when
 * read. The per-file list is capped so a folder with thousands of files cannot
 * turn the log into a second copy of the repository.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const HISTORY_FILE = 'history.jsonl'
export const MAX_ENTRIES = 200
export const MAX_ITEMS = 500

export function historyPath(profileDir) {
  return join(profileDir, '.repot', HISTORY_FILE)
}

async function readAll(profileDir) {
  let text
  try {
    text = await readFile(historyPath(profileDir), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a torn line is dropped rather than failing the whole log */
    }
  }
  return out
}

/** Newest first. */
export async function readHistory(profileDir, limit = 50) {
  const entries = await readAll(profileDir)
  return entries.slice(-limit).reverse()
}

/**
 * Append one entry. `items` is capped; the overflow is reported as
 * `{ truncated: true, more: n }` so the UI can say how much it is not showing.
 */
export async function appendHistory(profileDir, entry) {
  const entries = await readAll(profileDir)

  const record = { at: new Date().toISOString(), ...entry }
  if (Array.isArray(record.items) && record.items.length > MAX_ITEMS) {
    record.more = record.items.length - MAX_ITEMS
    record.truncated = true
    record.items = record.items.slice(0, MAX_ITEMS)
  }

  entries.push(record)
  while (entries.length > MAX_ENTRIES) entries.shift()

  const file = historyPath(profileDir)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')
  await rename(tmp, file)
  return record
}
