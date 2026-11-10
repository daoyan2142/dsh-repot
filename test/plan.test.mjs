import { test } from 'node:test'
import assert from 'node:assert/strict'

import { assertPlanWithinLimits, planBytes, splitForUpload } from '../lib/remote/plan.js'

const buf = (n) => Buffer.alloc(n, 1)

test('small files all ride inline in one batch', () => {
  const plan = splitForUpload([
    { path: 'a.json', content: buf(10), bytes: 10 },
    { path: 'b.yml', content: buf(20), bytes: 20 },
  ])
  assert.equal(plan.blobs.length, 0)
  assert.equal(plan.batches.length, 1)
  assert.equal(plan.batches[0].entries.length, 2)
  assert.equal(planBytes(plan), 30)
})

test('a file over the inline limit becomes a blob', () => {
  const plan = splitForUpload(
    [
      { path: 'small.txt', content: buf(10), bytes: 10 },
      { path: 'big.bin', content: buf(2048), bytes: 2048 },
    ],
    { inlineMaxBytes: 1024 },
  )
  assert.deepEqual(plan.blobs.map((b) => b.path), ['big.bin'])
  assert.equal(plan.batches[0].entries.length, 1)
  assert.equal(plan.batches[0].entries[0].path, 'small.txt')
})

test('inline entries are split into payload-sized batches', () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.txt`, content: buf(100), bytes: 100 }))
  const plan = splitForUpload(files, { batchMaxBytes: 250 })
  assert.equal(plan.batches.length, 3) // 100+100 / 100+100 / 100
  assert.deepEqual(
    plan.batches.map((b) => b.entries.length),
    [2, 2, 1],
  )
})

test('a single file larger than the batch limit still gets its own batch', () => {
  const plan = splitForUpload([{ path: 'x.txt', content: buf(200), bytes: 200 }], { batchMaxBytes: 100 })
  assert.equal(plan.batches.length, 1)
  assert.equal(plan.batches[0].entries.length, 1)
})

test('deletions are carried through the plan', () => {
  const plan = splitForUpload([{ path: 'a', content: buf(1), bytes: 1 }], { deletions: ['old/file.txt'] })
  assert.deepEqual(plan.deletions, ['old/file.txt'])
})

test('an empty upload produces an empty plan', () => {
  const plan = splitForUpload([])
  assert.equal(plan.blobs.length, 0)
  assert.equal(plan.batches.length, 0)
  assert.equal(planBytes(plan), 0)
})

test('limits reject too many files and too many bytes', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, content: buf(1), bytes: 1 }))
  const plan = splitForUpload(many)
  assert.throws(() => assertPlanWithinLimits(plan, { maxUploadFiles: 3 }), /文件数 5 超过上限 3/)

  const big = splitForUpload([{ path: 'huge', content: buf(4096), bytes: 4096 }], { inlineMaxBytes: 1024 })
  assert.throws(() => assertPlanWithinLimits(big, { maxUploadMB: 0.001 }), /上传体积/)
})
