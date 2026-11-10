/**
 * Render the real components to static HTML so they can be screenshotted.
 *
 * Uses the profile's own React (react-dom/server) and the plugin's own CSS, so
 * what gets captured is the actual markup and stylesheet, not a mockup.
 *
 *   node scripts/render-shots.mjs
 * then screenshot each .html under scripts/shots/ with Edge --headless.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR || join(process.cwd(), 'profile')
// React is not resolvable from the profile (the app bundles its own copy), so
// the render harness installs one into .tools/ next to this checkout.
const requireFromProfile = createRequire(join(process.cwd(), '.tools', 'package.json'))

const React = requireFromProfile('react')
const { renderToStaticMarkup } = requireFromProfile('react-dom/server')

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import(pathToFileURL(join(process.cwd(), 'client.js')).href)

const client = captured.factory((name) => {
  if (name === 'react') return React
  return requireFromProfile(name)
})
const { RepotSettings, RepotPanel, CompareView, PreflightDialog, HistoryCard, css } = client.__test

const THEME = `
  :root{
    --dsw-alias-label-primary:#e6e6e6;
    --dsw-alias-label-secondary:#9a9a9a;
    --dsw-alias-border-l2:rgba(255,255,255,.14);
    --dsw-alias-bg-layer-1:#1b1b1d;
    --dsw-alias-bg-input:rgba(255,255,255,.03);
    --dsw-alias-interactive-bg-hover:rgba(255,255,255,.06);
    --dsw-alias-brand-primary:#4c8dff;
    --dsw-font-mono:ui-monospace,SFMono-Regular,Consolas,monospace;
    --dsw-alias-text-success:#3fb950;
    --dsw-alias-text-danger:#f85149;
  }
  html,body{margin:0;background:#141416;color:#e6e6e6;font-family:"Microsoft YaHei UI","Segoe UI",system-ui,sans-serif}
  body{padding:18px}
  .stage{width:var(--stage, 760px)}
`

function page(title, body, stageWidth) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${THEME}</style><style>${css}</style>
<style>body{--stage:${stageWidth}px}</style></head>
<body><div class="stage">${body}</div></body></html>`
}

const compare = {
  plugins: {
    install: [
      { name: 'dsh-plugin-wallpaper-engine', version: '1.4.2' },
      { name: 'dshmarket', version: '1.73.17' },
    ],
    differ: [{ name: 'dsh-context', remoteVersion: '0.83.1', localVersion: '0.80.0' }],
    same: [],
  },
  config: {
    differ: [{ relPath: 'cordis.patch.yml', remote: 'a1b2c3d4' }],
    missingLocal: [{ relPath: 'pnpm-lock.yaml' }],
  },
  files: {
    unknown: [
      {
        id: 'work-notes',
        relPath: 'notes',
        diff: {
          supported: true,
          added: [{ relPath: 'plan.md' }, { relPath: 'src/todo.ts' }],
          changed: [],
          removed: [],
          counts: { added: 2, changed: 0, removed: 0 },
        },
      },
    ],
    differ: [
      {
        id: 'work-assets',
        relPath: 'assets',
        diff: {
          supported: true,
          added: [],
          changed: [{ relPath: 'logo.svg' }, { relPath: 'tokens/colors.json' }],
          removed: [{ relPath: 'old-banner.png' }],
          counts: { added: 0, changed: 2, removed: 1 },
        },
      },
    ],
  },
}

const pre = {
  results: [
    { id: 'work-notes', level: 3, writable: true, resolved: 'D:\\work\\notes', conflict: null, reason: null },
    { id: 'work-assets', level: 2, writable: true, resolved: 'D:\\work\\assets', conflict: null, reason: null },
    {
      id: 'work-foreign',
      level: 1,
      writable: false,
      resolved: 'D:\\work\\foreign',
      conflict: 'unmanaged-target',
      reason: '目标已存在且不是本插件创建的，拒绝覆盖',
    },
  ],
}

const historyEntries = [
  {
    at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
    kind: 'upload',
    commit: '8c1e4f2a91b7',
    revision: 7,
    indexSha: 'a1b2c3d4e5f60718',
    totals: { files: 13, bytes: 1048576 * 1.4 },
    items: [
      { path: 'config/cordis.patch.yml', bytes: 6932 },
      { path: 'config/package.json', bytes: 878 },
      { path: 'config/pnpm-lock.yaml', bytes: 54545 },
      { path: 'config/pnpm-workspace.yaml', bytes: 637 },
      { path: 'plugins/dsh-trae-console/index.js', bytes: 45930 },
      { path: 'plugins/dsh-runtime-kit/package.json', bytes: 1200 },
      { path: 'sync/manifest.json', bytes: 3120 },
    ],
  },
  {
    at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    kind: 'apply',
    revision: 7,
    indexSha: 'a1b2c3d4e5f60718',
    totals: { plugins: 3, config: 2, folders: 1, skipped: 0 },
    items: [],
  },
  {
    at: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    kind: 'upload',
    revision: 6,
    indexSha: '9f8e7d6c5b4a3928',
    totals: { files: 9, bytes: 734003 },
    items: [{ path: 'config/package.json', bytes: 878 }],
    preserved: ['plugins', 'files'],
    truncated: true,
    more: 40,
  },
]

const LIGHT = `
  :root{
    --dsw-alias-label-primary:#1f2328;
    --dsw-alias-label-secondary:#6b7280;
    --dsw-alias-border-l2:rgba(0,0,0,.16);
    --dsw-alias-bg-layer-1:#ffffff;
    --dsw-alias-bg-input:rgba(0,0,0,.02);
    --dsw-alias-interactive-bg-hover:rgba(0,0,0,.05);
    --dsw-alias-brand-primary:#2563eb;
    --dsw-font-mono:ui-monospace,SFMono-Regular,Consolas,monospace;
  }
  html,body{margin:0;background:#f6f7f9;color:#1f2328;font-family:"Microsoft YaHei UI","Segoe UI",system-ui,sans-serif}
  body{padding:18px}
`

function lightPage(title, body, stageWidth) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>${LIGHT}</style><style>${css}</style>
<style>body{--stage:${stageWidth}px}</style></head>
<body><div class="stage">${body}</div></body></html>`
}

const shots = [
  ['settings-wide', page('settings', renderToStaticMarkup(React.createElement(RepotSettings, { scope: { cwd: 'D:\\work' } })), 760)],
  ['settings-dialog', page('settings', renderToStaticMarkup(React.createElement(RepotSettings, { scope: { cwd: 'D:\\work' } })), 545)],
  ['settings-narrow', page('settings', renderToStaticMarkup(React.createElement(RepotSettings, { scope: { cwd: 'D:\\work' } })), 330)],
  ['settings-light', lightPage('settings', renderToStaticMarkup(React.createElement(RepotSettings, { scope: { cwd: 'D:\\work' } })), 760)],
  ['tab', page('tab', renderToStaticMarkup(React.createElement(RepotPanel, { scope: { cwd: 'D:\\work' } })), 360)],
  [
    'compare',
    page(
      'compare',
      renderToStaticMarkup(
        React.createElement(CompareView, {
          compare,
          applySel: { plugins: { dshmarket: true }, config: {}, folders: {} },
          setApplySel: () => {},
          onApply: () => {},
          onReload: () => {},
          busy: '',
        }),
      ),
      360,
    ),
  ],
  ['preflight', page('preflight', renderToStaticMarkup(React.createElement(PreflightDialog, { pre, onCancel: () => {}, onConfirm: () => {} })), 720)],
  ['history', page('history', renderToStaticMarkup(React.createElement(HistoryCard, { entries: historyEntries, busy: '', onReload: () => {} })), 420)],
]

const outDir = join(process.cwd(), 'scripts', 'shots')
await mkdir(outDir, { recursive: true })

// A collapsed variant: the card state reads localStorage on first render.
globalThis.localStorage = { getItem: () => '0', setItem: () => {}, removeItem: () => {} }
const collapsed = renderToStaticMarkup(React.createElement(RepotSettings, { scope: { cwd: 'D:\\work' } }))
delete globalThis.localStorage
shots.push(['settings-collapsed', page('settings', collapsed, 760)])

for (const [name, html] of shots) {
  await writeFile(join(outDir, `${name}.html`), html, 'utf8')
}
console.log(`wrote ${shots.length} html files to ${outDir}`)
