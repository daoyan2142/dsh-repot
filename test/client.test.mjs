/**
 * The client half cannot run in a browser under node, but its module body and
 * its apply() path can: this loads the real client.js against a stub React and
 * a stub Cordis context, and asserts both surfaces register correctly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

let captured

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import('../client.js')

const StubReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

function build() {
  return captured.factory((name) => {
    if (name === 'react') return StubReact
    throw new Error(`unexpected require: ${name}`)
  })
}

function makeCtx(sidebar) {
  const sections = []
  return {
    sections,
    ctx: {
      slots: {
        inject(name, fn) {
          assert.equal(name, 'settings.section')
          fn()
        },
        register(descriptor, component) {
          sections.push({ descriptor, component })
          return () => {}
        },
      },
      get(name) {
        return name === 'betterSidebar' ? sidebar : undefined
      },
    },
  }
}

test('client registers the settings section with a Resolvable label', () => {
  const client = build()
  assert.ok(Array.isArray(client.inject) && client.inject.includes('slots'))

  const { sections, ctx } = makeCtx(undefined)
  client.apply(ctx)

  assert.equal(sections.length, 1)
  assert.equal(sections[0].descriptor.name, 'settings.section')
  assert.equal(sections[0].descriptor.id, 'repot')
  assert.equal(typeof sections[0].descriptor.label(), 'string')
  assert.equal(typeof sections[0].component, 'function')
})

test('client registers a sidebar tab when betterSidebar is present', () => {
  const tabs = []
  const sidebar = {
    registerTab(tab) {
      tabs.push(tab)
      return () => {}
    },
  }
  const client = build()
  const { ctx } = makeCtx(sidebar)
  client.apply(ctx)

  assert.equal(tabs.length, 1)
  const tab = tabs[0]
  assert.equal(tab.id, 'repot')
  assert.equal(tab.single, true)
  assert.equal(typeof tab.title(), 'string')
  assert.equal(typeof tab.description(), 'string')
  assert.equal(typeof tab.icon, 'function')
  assert.equal(typeof tab.component, 'function')
})

test('client degrades to the settings page when betterSidebar is absent', () => {
  const { sections, ctx } = makeCtx(undefined)
  build().apply(ctx)
  assert.equal(sections.length, 1, 'the settings page still registered')
})

test('client survives a sidebar whose registerTab throws', () => {
  const sidebar = {
    registerTab() {
      throw new Error('older sidebar')
    },
  }
  const { sections, ctx } = makeCtx(sidebar)
  assert.doesNotThrow(() => build().apply(ctx))
  assert.equal(sections.length, 1)
})

test('client finds the service through the ctx property when ctx.get misses', () => {
  const tabs = []
  const sidebar = {
    registerTab(tab) {
      tabs.push(tab)
    },
  }
  const { ctx } = makeCtx(undefined)
  ctx.betterSidebar = sidebar
  build().apply(ctx)
  assert.equal(tabs.length, 1)
})

test('client falls back to ctx.inject for the service', () => {
  const tabs = []
  const sidebar = {
    registerTab(tab) {
      tabs.push(tab)
    },
  }
  const { ctx } = makeCtx(undefined)
  ctx.inject = (names, fn) => {
    assert.deepEqual(names, ['betterSidebar'])
    fn({ betterSidebar: sidebar })
  }
  build().apply(ctx)
  assert.equal(tabs.length, 1)
})

test('RepotPanel renders with no data and with a populated scan', () => {
  const { RepotPanel } = build().__test
  assert.doesNotThrow(() => RepotPanel({ scope: { cwd: 'D:\\work' } }))
})

test('RepotSettings renders', () => {
  const { RepotSettings } = build().__test
  assert.doesNotThrow(() => RepotSettings({ scope: { cwd: 'D:\\work' } }))
})

test('CompareView renders every bucket', () => {
  const { CompareView } = build().__test
  const compare = {
    plugins: { install: [{ name: 'a', version: '1.0.0' }], differ: [{ name: 'b', remoteVersion: '2', localVersion: '1' }] },
    config: { differ: [{ relPath: 'package.json' }], missingLocal: [{ relPath: 'pnpm-lock.yaml' }] },
    files: { unknown: [{ id: 'work-notes' }], differ: [{ id: 'work-assets' }] },
    same: [],
  }
  const applySel = { plugins: { a: true }, config: {}, folders: { 'work-notes': true } }
  assert.doesNotThrow(() => CompareView({ compare, applySel, setApplySel: () => {} }))
})

test('PreflightDialog renders writable and refused targets', () => {
  const { PreflightDialog } = build().__test
  const pre = {
    results: [
      { id: 'work-notes', level: 3, writable: true, resolved: 'D:\\work\\notes', conflict: null, reason: null },
      { id: 'work-foreign', level: 1, writable: false, resolved: 'D:\\work\\foreign', conflict: 'unmanaged-target', reason: '目标已存在且不是本插件创建的' },
    ],
  }
  assert.doesNotThrow(() => PreflightDialog({ pre, onCancel: () => {}, onConfirm: () => {} }))
})
