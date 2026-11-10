import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, realpath, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  HISTORY_FILE,
  MAX_ENTRIES,
  MAX_ITEMS,
  appendHistory,
  historyPath,
  readHistory,
} from '../lib/history.js'

async function tmp(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

test('appendHistory writes one line per operation and readHistory returns newest first', async () => {
  const profile = await tmp('repot-log-')
  try {
    await appendHistory(profile, { kind: 'upload', commit: 'a1', totals: { files: 1, bytes: 10 }, items: [{ path: 'a', bytes: 10 }] })
    await appendHistory(profile, { kind: 'apply', totals: { plugins: 2 } })

    const raw = await readFile(historyPath(profile), 'utf8')
    assert.equal(raw.trim().split('\n').length, 2)

    const entries = await readHistory(profile)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].kind, 'apply', 'newest first')
    assert.equal(entries[1].kind, 'upload')
    assert.equal(entries[1].commit, 'a1')
    assert.ok(entries[1].at, 'a timestamp is stamped')
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('readHistory on a missing log is empty, not an error', async () => {
  const profile = await tmp('repot-log-')
  try {
    assert.deepEqual(await readHistory(profile), [])
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('a torn line is dropped instead of failing the read', async () => {
  const profile = await tmp('repot-log-')
  try {
    await mkdir(join(profile, '.repot'), { recursive: true })
    await writeFile(
      historyPath(profile),
      `${JSON.stringify({ kind: 'upload', at: '2026-01-01T00:00:00Z' })}\n{"broken":\n`,
      'utf8',
    )
    const entries = await readHistory(profile)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].kind, 'upload')
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('the file keeps only the newest MAX_ENTRIES entries', async () => {
  const profile = await tmp('repot-log-')
  try {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      await appendHistory(profile, { kind: 'upload', commit: `c${i}` })
    }
    const entries = await readHistory(profile, 999)
    assert.equal(entries.length, MAX_ENTRIES)
    assert.equal(entries[0].commit, `c${MAX_ENTRIES + 4}`, 'newest survives')
    assert.equal(entries[entries.length - 1].commit, 'c5', 'oldest five were dropped')
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('an oversized file list is capped and reports the remainder', async () => {
  const profile = await tmp('repot-log-')
  try {
    const items = Array.from({ length: MAX_ITEMS + 20 }, (_, i) => ({ path: `f${i}`, bytes: 1 }))
    const record = await appendHistory(profile, { kind: 'upload', items })

    assert.equal(record.items.length, MAX_ITEMS)
    assert.equal(record.truncated, true)
    assert.equal(record.more, 20)

    const [entry] = await readHistory(profile)
    assert.equal(entry.items.length, MAX_ITEMS)
    assert.equal(entry.more, 20)
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('the log filename stays inside the profile', async () => {
  assert.equal(HISTORY_FILE, 'history.jsonl')
  assert.ok(historyPath('C:\\p').endsWith(join('.repot', 'history.jsonl')))
})
