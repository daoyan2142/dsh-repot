window.__ModuleLoader__.load({
  id: 'dsh-repot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const isZh = /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || 'zh')
    const L = (zh, en) => (isZh ? zh : en)

    function fmt(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    // ------------------------------------------------------------ styles ---
    // Injected once. Class-based so layout adapts to the container: grids use
    // auto-fit rather than viewport breakpoints, which is what the narrow
    // sidebar and the wide settings page both need from one sheet.
    const CSS = `
.rp-root{max-width:780px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:1.5}
.rp-root,.rp-root *{box-sizing:border-box}
.rp-hero{display:flex;flex-direction:column;gap:3px;padding-bottom:2px}
.rp-h1{font-size:15px;font-weight:600;letter-spacing:.2px}
.rp-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#9a9a9a)}
.rp-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));border-radius:12px;padding:6px 16px 16px;display:flex;flex-direction:column;gap:6px}
.rp-card.rp-collapsed{padding:6px 16px 8px}
.rp-card-body{display:flex;flex-direction:column;gap:14px;padding-top:6px}
.rp-card-head{display:flex;align-items:center;gap:8px;min-height:30px}
.rp-card-head.rp-clickable{cursor:pointer;user-select:none;margin:0 -8px;padding:0 8px;border-radius:8px}
.rp-card-head.rp-clickable:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.rp-card-head.rp-clickable:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}
.rp-chevron{display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;color:var(--dsw-alias-label-secondary,#9a9a9a);flex:0 0 auto}
.rp-card-title{font-size:13px;font-weight:600}
.rp-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));align-items:start}
.rp-grid-repo{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));align-items:start}
.rp-span-2{grid-column:1/-1}
.rp-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.rp-label{font-size:12px;color:var(--dsw-alias-label-secondary,#9a9a9a);display:flex;align-items:center;gap:8px}
.rp-hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#9a9a9a)}
.rp-input{width:100%;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:inherit;font:inherit;font-size:12.5px;outline:none;min-width:0}
.rp-input::placeholder{color:var(--dsw-alias-label-secondary,#8a8a8a);opacity:.8}
.rp-input:focus{border-color:var(--dsw-alias-brand-primary,#4c8dff);box-shadow:0 0 0 2px color-mix(in srgb,#4c8dff 20%,transparent)}
.rp-seg{display:inline-flex;padding:2px;gap:2px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));width:fit-content}
.rp-seg button{height:26px;padding:0 14px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.rp-seg button:hover:not(.on){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.rp-seg button.on{background:color-mix(in srgb,#4c8dff 18%,transparent);color:var(--dsw-alias-brand-primary,#7fb0ff);box-shadow:inset 0 0 0 1px color-mix(in srgb,#4c8dff 45%,transparent)}
.rp-btn{height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.rp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.rp-btn:disabled{opacity:.45;cursor:default}
.rp-btn.primary{border-color:color-mix(in srgb,#4c8dff 55%,transparent);color:var(--dsw-alias-brand-primary,#8ab4ff);background:color-mix(in srgb,#4c8dff 13%,transparent)}
.rp-btn.icon{width:28px;padding:0;height:28px}
.rp-row{display:flex;align-items:center;gap:10px;min-width:0}
.rp-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.rp-badge{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:999px;font-size:11px;line-height:1;white-space:nowrap;flex:0 0 auto;border:1px solid}
.rp-badge.ok{color:#3fb950;border-color:color-mix(in srgb,#3fb950 50%,transparent)}
.rp-badge.warn{color:#d29922;border-color:color-mix(in srgb,#d29922 50%,transparent)}
.rp-badge.danger{color:#f85149;border-color:color-mix(in srgb,#f85149 50%,transparent)}
.rp-badge.muted{color:var(--dsw-alias-label-secondary,#9a9a9a);border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.35))}
.rp-list{display:flex;flex-direction:column;gap:1px}
.rp-item{display:flex;align-items:center;gap:8px;min-height:28px;padding:2px 6px;border-radius:6px;font-size:12px;min-width:0}
.rp-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.rp-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#9a9a9a);white-space:nowrap}
.rp-status{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.5}
.rp-status.error{color:#f85149}
.rp-dot{width:6px;height:6px;border-radius:50%;background:currentColor;margin-top:6px;flex:0 0 auto}
.rp-root-row{display:flex;align-items:center;gap:8px;min-width:0}
.rp-target-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding:3px 0}
.rp-target-name{width:52px;flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary,#9a9a9a)}
.rp-target-inherit{font-size:11px;color:var(--dsw-alias-label-secondary,#9a9a9a);min-width:30px;text-align:center}
.rp-select{width:auto;flex:0 0 auto;height:32px;padding:0 6px}
.rp-root-id{width:68px;flex:0 0 auto;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#9a9a9a);overflow:hidden;text-overflow:ellipsis}
.rp-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0 2px;margin-top:2px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22))}
.rp-spacer{flex:1 1 auto}
.rp-tab-head{display:flex;align-items:center;gap:8px;min-width:0;padding-bottom:2px}
.rp-tab-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.rp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:80;padding:16px}
.rp-dialog{width:min(560px,100%);max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#1b1b1d);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,inherit);font-size:13px}
.rp-pre-row{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}
.rp-pre-path{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;word-break:break-all;color:var(--dsw-alias-label-primary,inherit)}
.rp-log{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto}
.rp-log-entry{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}
.rp-log-entry:first-child{border-top:0;padding-top:0}
.rp-log-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;min-width:0}
.rp-log-paths{display:flex;flex-direction:column;gap:1px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#9a9a9a);word-break:break-all}
.rp-diff{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.12))}
.rp-diff:first-child{border-top:0}
.rp-diff .rp-log-paths{padding:0 0 6px 24px}
`

    let cssReady = false
    function ensureCss() {
      if (cssReady || typeof document === 'undefined') return
      cssReady = true
      if (document.getElementById('repot-style')) return
      const el = document.createElement('style')
      el.id = 'repot-style'
      el.textContent = CSS
      document.head.appendChild(el)
    }

    async function call(method, body) {
      const res = await fetch('/repot/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await res.json().catch(() => null)
      if (!data || !data.ok) {
        const err = new Error((data && data.error && data.error.message) || 'HTTP ' + res.status)
        err.code = data && data.error && data.error.code
        throw err
      }
      return data.value
    }

    // Called two ways: as an element child and as a tab descriptor `icon(size)`.
    const Icon = (arg) => {
      const size = typeof arg === 'number' ? arg : Number(arg && arg.size) || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          style: { flex: '0 0 auto' },
        },
        h('path', { d: 'M2.5 10h11l-1.1 3.5H3.6z' }),
        h('path', { d: 'M8 8V2.2' }),
        h('path', { d: 'M5.7 4.4 8 2.1l2.3 2.3' }),
        h('path', { d: 'M5.2 10V7.6h5.6V10' }),
      )
    }

    // -------------------------------------------------------- primitives ---
    function Btn({ children, onClick, disabled, primary, title, className }) {
      return h(
        'button',
        {
          className: ['rp-btn', primary ? 'primary' : '', className || ''].join(' ').trim(),
          onClick,
          disabled: Boolean(disabled),
          title,
        },
        children,
      )
    }

    function Badge({ children, tone }) {
      return h('span', { className: 'rp-badge ' + (tone || 'muted') }, children)
    }

    function Card({ title, right, children, id, defaultOpen = true, collapsible = true }) {
      const key = `repot.card.${id || String(title)}`
      const [open, setOpen] = useState(() => {
        try {
          const saved = localStorage.getItem(key)
          if (saved === '0') return false
          if (saved === '1') return true
        } catch {
          /* no storage in this context */
        }
        return defaultOpen
      })

      const toggle = () => {
        if (!collapsible) return
        const next = !open
        setOpen(next)
        try {
          localStorage.setItem(key, next ? '1' : '0')
        } catch {
          /* ignore */
        }
      }

      return h(
        'div',
        { className: 'rp-card' + (open ? '' : ' rp-collapsed') },
        h(
          'div',
          {
            className: 'rp-card-head' + (collapsible ? ' rp-clickable' : ''),
            onClick: toggle,
            role: collapsible ? 'button' : undefined,
            tabIndex: collapsible ? 0 : undefined,
            onKeyDown: (e) => {
              if (!collapsible) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggle()
              }
            },
          },
          h(
            'span',
            { className: 'rp-chevron', 'aria-hidden': 'true' },
            // Two explicit paths instead of a CSS rotation: rotation on an
            // inline-flex box is not reliable across every host webview.
            h(
              'svg',
              {
                width: 13,
                height: 13,
                viewBox: '0 0 16 16',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.8,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              },
              h('path', { d: open ? 'M3.5 6 8 10.5 12.5 6' : 'M6 3.5 10.5 8 6 12.5' }),
            ),
          ),
          h('div', { className: 'rp-card-title' }, title),
          h('span', { className: 'rp-spacer' }),
          h('span', { onClick: (e) => e.stopPropagation(), style: { display: 'inline-flex' } }, right || null),
        ),
        open ? h('div', { className: 'rp-card-body' }, children) : null,
      )
    }

    function Field({ label, hint, children, className }) {
      return h(
        'div',
        { className: 'rp-field ' + (className || '') },
        h('div', { className: 'rp-label' }, label),
        children,
        hint ? h('div', { className: 'rp-hint' }, hint) : null,
      )
    }

    function Status({ error, note }) {
      if (!error && !note) return null
      return h(
        'div',
        { className: 'rp-status' + (error ? ' error' : '') },
        h('span', { className: 'rp-dot' }),
        h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, error || note),
      )
    }

    /** Per-set repository overrides. An empty repo means "inherit the default". */
    function TargetEditor({ targets, defaults, onChange }) {
      const names = ['plugins', 'config', 'files']
      const labels = { plugins: L('插件', 'Plugins'), config: L('配置', 'Configuration'), files: L('文件夹', 'Folders') }

      const row = (set) => {
        const fallback = defaults[set] || { platform: 'github', repo: '', branch: 'main' }
        const value = targets[set] || { platform: fallback.platform, repo: '', branch: '' }
        const setValue = (patch) => {
          const next = { platform: value.platform, repo: value.repo, branch: value.branch, ...patch }
          onChange({ ...targets, [set]: next.repo.trim() ? next : null })
        }

        return h(
          'div',
          { key: set, className: 'rp-target-row' },
          h('span', { className: 'rp-target-name' }, labels[set]),
          h(
            'select',
            {
              className: 'rp-input rp-select',
              value: value.platform,
              onChange: (e) => setValue({ platform: e.target.value }),
            },
            h('option', { value: 'github' }, 'GitHub'),
            h('option', { value: 'gitee' }, 'Gitee'),
          ),
          h('input', {
            className: 'rp-input',
            style: { flex: '1 1 180px' },
            value: value.repo,
            placeholder: fallback.repo ? `${fallback.repo}` : 'owner/repo',
            onChange: (e) => setValue({ repo: e.target.value }),
          }),
          h('input', {
            className: 'rp-input',
            style: { flex: '0 1 120px' },
            value: value.branch,
            placeholder: fallback.branch,
            onChange: (e) => setValue({ branch: e.target.value }),
          }),
          targets[set]
            ? h(Btn, { className: 'icon', onClick: () => onChange({ ...targets, [set]: null }) }, '×')
            : h('span', { className: 'rp-target-inherit' }, L('默认', 'default')),
        )
      }

      return h('div', { className: 'rp-list' }, names.map(row))
    }

    /** `MM-DD HH:mm` in the local zone, stable regardless of locale. */
    function stamp(iso) {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso || '')
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    function setLabel(set) {
      if (set === 'plugins') return L('插件', 'plugins')
      if (set === 'config') return L('配置', 'config')
      return L('文件夹', 'folders')
    }

    function describeEntry(entry) {
      const t = entry.totals || {}
      if (entry.kind === 'apply') {
        return L(
          `插件 ${t.plugins || 0} · 配置 ${t.config || 0} · 文件夹 ${t.folders || 0}${t.skipped ? ` · 跳过 ${t.skipped}` : ''}`,
          `plugins ${t.plugins || 0} · config ${t.config || 0} · folders ${t.folders || 0}${t.skipped ? ` · skipped ${t.skipped}` : ''}`,
        )
      }
      // Sets this commit did not touch keep their index entries; say so, because
      // the file list below only ever shows what this commit moved.
      const kept = Array.isArray(entry.preserved) ? entry.preserved : []
      const tail = kept.length ? ` · ${L('保留', 'kept')} ${kept.map(setLabel).join(' / ')}` : ''
      return `${t.files || 0} ${L('个文件', 'files')} · ${fmt(t.bytes || 0)}${tail}`
    }

    function HistoryCard({ entries, busy, onReload, ready }) {
      ensureCss()
      return h(
        Card,
        {
          title: L('提交日志', 'History'),
          id: 'history',
          right: h(
            'div',
            { className: 'rp-wrap' },
            h('span', { className: 'rp-mono' }, String(entries.length)),
            onReload ? h(Btn, { disabled: busy, onClick: onReload }, L('刷新', 'Refresh')) : null,
          ),
        },
        ready === false
          ? h(
              'div',
              { className: 'rp-hint', style: { color: '#d29922' } },
              L(
                '后端还没有日志接口：这个功能是新加的，需要重启 DSH 才会加载。客户端刷新只换界面，host 半只在启动时加载。',
                'The Host half has no history route yet: it is new code and loads only when DSH starts. A page refresh reloads the client only.',
              ),
            )
          : entries.length === 0
          ? h('div', { className: 'rp-hint' }, L('还没有记录。提交或拉取一次就会出现。', 'Nothing yet — commit or pull once.'))
          : h(
              'div',
              { className: 'rp-log' },
              entries.map((entry, i) =>
                h(
                  'div',
                  { key: `${entry.at}-${i}`, className: 'rp-log-entry' },
                  h(
                    'div',
                    { className: 'rp-log-head' },
                    h('span', { className: 'rp-mono' }, stamp(entry.at)),
                    entry.kind === 'apply'
                      ? h(Badge, { tone: 'warn' }, L('应用', 'Apply'))
                      : h(Badge, { tone: 'ok' }, L('提交', 'Commit')),
                    entry.revision
                      ? h(
                          'span',
                          { className: 'rp-mono', title: L('清单版本', 'Index revision') },
                          `${entry.kind === 'apply' ? '← ' : ''}v${entry.revision}`,
                        )
                      : null,
                    entry.commit
                      ? h('span', { className: 'rp-mono' }, String(entry.commit).slice(0, 7))
                      : // Gitee writes one file per commit, so there is no single
                        // sha; the index fingerprint is the only id available.
                        entry.indexSha
                        ? h('span', { className: 'rp-mono', title: L('清单指纹', 'Index fingerprint') }, `#${String(entry.indexSha).slice(0, 7)}`)
                        : null,
                    h('span', { style: { color: 'var(--dsw-alias-label-secondary,#9a9a9a)' } }, describeEntry(entry)),
                  ),
                  entry.kind === 'upload' && Array.isArray(entry.items) && entry.items.length
                    ? h(
                        'div',
                        { className: 'rp-log-paths' },
                        entry.items
                          .slice(0, 12)
                          .map((item) => h('span', { key: item.path }, `${item.path}  ${fmt(item.bytes || 0)}`)),
                        entry.items.length > 12 || entry.truncated
                          ? h(
                              'span',
                              { style: { color: 'var(--dsw-alias-label-secondary,#9a9a9a)' } },
                              L(
                                `… 另有 ${(entry.more || 0) + Math.max(0, entry.items.length - 12)} 个文件`,
                                `… ${(entry.more || 0) + Math.max(0, entry.items.length - 12)} more`,
                              ),
                            )
                          : null,
                      )
                    : null,
                ),
              ),
            ),
      )
    }

    function useBusy() {
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [note, setNote] = useState('')
      const run = useCallback(async (tag, fn) => {
        setBusy(tag)
        setError('')
        setNote('')
        try {
          return await fn()
        } catch (e) {
          setError(e.message)
          return undefined
        } finally {
          setBusy('')
        }
      }, [])
      return { busy, error, note, setNote, setError, run }
    }

    // --------------------------------------------------------- settings ---
    function RootsEditor({ roots, onChange, suggest }) {
      ensureCss()
      const list = roots || []
      const [id, setId] = useState('work')
      const [path, setPath] = useState(suggest || '')

      const update = (i, next) => {
        const copy = list.slice()
        copy[i] = { ...copy[i], path: next }
        onChange(copy)
      }

      return h(
        'div',
        { className: 'rp-field' },
        list.length
          ? h(
              'div',
              { className: 'rp-list' },
              list.map((root, i) =>
                h(
                  'div',
                  { key: root.id, className: 'rp-root-row' },
                  h('span', { className: 'rp-root-id', title: root.id }, root.id),
                  h('input', {
                    className: 'rp-input',
                    value: root.path,
                    onChange: (e) => update(i, e.target.value),
                  }),
                  h(Btn, { className: 'icon', onClick: () => onChange(list.filter((_, j) => j !== i)) }, '×'),
                ),
              ),
            )
          : null,
        list.length >= 3
          ? h('div', { className: 'rp-hint' }, L('最多 3 个根', 'At most 3 roots'))
          : h(
              'div',
              { className: 'rp-wrap' },
              h('input', {
                className: 'rp-input',
                style: { width: 88, flex: '0 0 auto' },
                value: id,
                placeholder: 'id',
                onChange: (e) => setId(e.target.value),
              }),
              h('input', {
                className: 'rp-input',
                style: { flex: '1 1 160px' },
                value: path,
                placeholder: 'D:\\work',
                onChange: (e) => setPath(e.target.value),
              }),
              h(
                Btn,
                {
                  onClick: () => {
                    if (!id.trim() || !path.trim()) return
                    onChange(list.concat([{ id: id.trim(), path: path.trim() }]))
                    setPath('')
                  },
                },
                L('添加', 'Add'),
              ),
            ),
        h(
          'div',
          { className: 'rp-hint' },
          L(
            '根是跨机器的锚点：id 不变，路径在新机器上重新指定。不能是盘符根，目录必须已存在。',
            'A root is the anchor that survives a machine change: the id stays, the path is re-pointed. Not a drive root, and the folder must exist.',
          ),
        ),
      )
    }

    function RepotSettings({ scope }) {
      ensureCss()
      const [state, setState] = useState(null)
      const [platform, setPlatform] = useState('github')
      const [repo, setRepo] = useState('')
      const [branch, setBranch] = useState('main')
      const [token, setToken] = useState('')
      const [roots, setRoots] = useState([])
      const [targets, setTargets] = useState({ plugins: null, config: null, files: null })
      const [repoCheck, setRepoCheck] = useState(null)
      const { busy, error, note, setNote, run } = useBusy()
      const currentCheck = repoCheck && repoCheck.for === platform + '/' + repo ? repoCheck : null

      const refresh = useCallback(async () => {
        try {
          const next = await call('state')
          setState(next)
          setPlatform(next.platform)
          setRepo(next.repo || '')
          setBranch(next.branch || 'main')
          setRoots(next.roots || [])
          setTargets(next.targets || { plugins: null, config: null, files: null })
        } catch (e) {
          setNote(e.message)
        }
      }, [setNote])

      useEffect(() => {
        refresh()
      }, [refresh])

      const persist = () => call('settings', { platform, repo, branch, roots, targets })
      const hasToken = Boolean(state && state.tokens && state.tokens[platform])

      return h(
        'div',
        { className: 'rp-root' },
        h(
          'div',
          { className: 'rp-hero' },
          h('div', { className: 'rp-h1' }, L('环境搬运', 'Environment carry')),
          h(
            'div',
            { className: 'rp-sub' },
            state && state.migrated
              ? L('已从 dsh-plugin-git-sync 继承设置，旧文件保留未动。', 'Settings carried over from dsh-plugin-git-sync; the old file is untouched.')
              : L(
                  '把插件、配置和文件夹经一个私有仓库搬到另一台机器。完整操作就在下面，侧栏「Repot」里也有。',
                  'Carry plugins, configuration and folders between machines through one private repository. The full set of actions is right below, and also in the Repot sidebar tab.',
                ),
          ),
        ),

        h(
          Card,
          { title: L('仓库', 'Repository'), id: 'repo' },
          h(
            'div',
            { className: 'rp-grid-repo' },
            h(
              Field,
              { label: L('仓库地址', 'Repository'), className: 'rp-span-2' },
              h('input', {
                className: 'rp-input',
                value: repo,
                placeholder: 'owner/repo',
                onChange: (e) => {
                  const v = e.target.value
                  setRepo(v)
                  const hit = /gitee\.com/i.test(v) ? 'gitee' : /github\.com/i.test(v) ? 'github' : null
                  if (hit && hit !== platform) setPlatform(hit)
                },
              }),
            ),
            h(
              Field,
              { label: L('平台', 'Platform') },
              h(
                'div',
                { className: 'rp-seg' },
                ['github', 'gitee'].map((p) =>
                  h(
                    'button',
                    {
                      key: p,
                      className: platform === p ? 'on' : '',
                      onClick: () => {
                        setPlatform(p)
                        const prof = state && state.profiles && state.profiles[p]
                        setRepo((prof && prof.repo) || '')
                        setBranch((prof && prof.branch) || (p === 'gitee' ? 'master' : 'main'))
                      },
                    },
                    p === 'github' ? 'GitHub' : 'Gitee',
                  ),
                ),
              ),
            ),
            h(
              Field,
              { label: L('分支', 'Branch') },
              h('input', { className: 'rp-input', value: branch, onChange: (e) => setBranch(e.target.value) }),
            ),
          ),

          h(
            Field,
            {
              label: h(
                'span',
                { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                L('个人访问令牌', 'Personal access token'),
                h(Badge, { tone: hasToken ? 'ok' : 'muted' }, hasToken ? L('已配置', 'Set') : L('未配置', 'Missing')),
              ),
              hint: L('存入 DSH 凭据服务，不会出现在任何响应或提交里。', 'Stored in the DSH credentials service — never in a response or a commit.'),
            },
            h(
              'div',
              { className: 'rp-wrap' },
              h('input', {
                className: 'rp-input',
                style: { flex: '1 1 220px' },
                type: 'password',
                value: token,
                placeholder: hasToken ? L('已保存，输入新值可覆盖', 'Saved — type a new value to replace') : L('粘贴 token', 'Paste token'),
                onChange: (e) => setToken(e.target.value),
              }),
              h(
                Btn,
                {
                  primary: true,
                  disabled: busy,
                  onClick: () =>
                    run('token', async () => {
                      await persist()
                      await call('token/save', { platform, token })
                      setRepoCheck(null)
                      setToken('')
                      await refresh()
                      setNote(L('令牌已保存', 'Token saved'))
                    }),
                },
                L('保存', 'Save'),
              ),
            ),
          ),

          h(
            'div',
            {
              className: 'rp-status' + (currentCheck && currentCheck.ok === false ? ' error' : ''),
              style: { marginTop: 2 },
            },
            h('span', { className: 'rp-dot' }),
            h(
              'span',
              null,
              (currentCheck
                ? currentCheck.ok
                  ? L('仓库可访问：', 'Repository reachable: ')
                  : L('校验失败：', 'Check failed: ')
                : L('目标仓库：', 'Target repository: ')) +
                (currentCheck && currentCheck.text
                  ? currentCheck.text
                  : repo
                    ? (platform === 'github' ? 'github.com/' : 'gitee.com/') + repo
                    : L('还没有填仓库地址', 'no repository yet')),
            ),
          ),
          h(
            'div',
            { className: 'rp-wrap' },
            h(
              Btn,
              {
                primary: true,
                disabled: busy,
                onClick: () =>
                  run('save', async () => {
                    await persist()
                    await refresh()
                    setNote(L('已保存', 'Saved'))
                  }),
              },
              L('保存设置', 'Save'),
            ),
            h(
              Btn,
              {
                disabled: busy,
                onClick: () =>
                  run('verify', async () => {
                    const r = await call('verify', { platform, repo, branch })
                    setNote('')
                    setRepoCheck({ ok: Boolean(r.ok), text: r.ok ? r.name : r.message, for: platform + '/' + repo })
                  }),
              },
              L('验证仓库', 'Verify'),
            ),
            busy ? h('span', { className: 'rp-hint' }, L('处理中…', 'Working…')) : null,
          ),
        ),

        h(
          Card,
          { title: L('同步根', 'Sync roots'), id: 'roots' },
          h(RootsEditor, { roots, onChange: setRoots, suggest: (scope && scope.cwd) || '' }),
        ),

        h(
          Card,
          { title: L('分集仓库', 'Per-set repositories'), id: 'targets' },
          h(
            'div',
            { className: 'rp-hint' },
            L(
              '默认三类集都用上面的仓库。某一类要放到别的仓库（比如插件在 Gitee、文件在 GitHub），在这里单独指定；留空即沿用默认。',
              'By default all three sets use the repository above. Point a set somewhere else here (plugins on Gitee, files on GitHub) — leave it empty to inherit.',
            ),
          ),
          h(TargetEditor, {
            targets,
            defaults: (state && state.resolved) || {
              plugins: { platform, repo, branch },
              config: { platform, repo, branch },
              files: { platform, repo, branch },
            },
            onChange: setTargets,
          }),
        ),

        // The same operation surface the sidebar tab carries, so the settings
        // page is never a dead end and works when better-sidebar is absent.
        h(RepotPanel, { scope, embedded: true }),

        h(Status, { error, note }),
      )
    }

    // -------------------------------------------------------------- tab ---
    function RepotPanel({ scope, embedded }) {
      ensureCss()
      const [state, setState] = useState(null)
      const [scan, setScan] = useState(null)
      const [compare, setCompare] = useState(null)
      const [plug, setPlug] = useState({})
      const [cfg, setCfg] = useState({})
      const [folders, setFolders] = useState([])
      const [folderOn, setFolderOn] = useState({})
      const [applySel, setApplySel] = useState({ plugins: {}, config: {}, folders: {} })
      const [history, setHistory] = useState([])
      const [historyReady, setHistoryReady] = useState(true)
      const [pre, setPre] = useState(null)
      const [newFolder, setNewFolder] = useState('')
      const { busy, error, note, setNote, run } = useBusy()

      const loadState = useCallback(async () => {
        try {
          setState(await call('state'))
        } catch {
          /* the settings page surfaces this */
        }
      }, [])

      const loadHistory = useCallback(async () => {
        try {
          const result = await call('history', { limit: 30 })
          setHistory(result.entries || [])
          setHistoryReady(true)
        } catch (e) {
          // A missing route means the Host half predates this feature.
          if (e.code === 'not-found') setHistoryReady(false)
        }
      }, [])

      const doScan = useCallback(
        async (list) => {
          const target = list || folders
          const result = await run('scan', () => call('scan', { folders: target.map((f) => f.absPath) }))
          if (!result) return
          setScan(result)
          const nextPlug = {}
          for (const item of (result.plugins && result.plugins.items) || []) {
            nextPlug[item.name] = { on: true, carry: item.kind !== 'registry' }
          }
          setPlug(nextPlug)
          const nextCfg = {}
          for (const item of (result.config && result.config.items) || []) nextCfg[item.relPath] = true
          setCfg(nextCfg)
          const nextOn = {}
          for (const f of target) nextOn[f.absPath] = true
          setFolderOn(nextOn)
        },
        [folders, run],
      )

      useEffect(() => {
        loadState()
        loadHistory()
        doScan([])
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const selectedPlugins = () =>
        ((scan && scan.plugins && scan.plugins.items) || [])
          .filter((item) => plug[item.name] && plug[item.name].on)
          .map((item) => ({ name: item.name, carry: Boolean(plug[item.name].carry) }))

      const selectedConfig = () =>
        ((scan && scan.config && scan.config.items) || []).filter((item) => cfg[item.relPath]).map((i) => i.relPath)

      const doUpload = () =>
        run('upload', async () => {
          const result = await call('upload', {
            plugins: selectedPlugins(),
            config: selectedConfig(),
            folders: folders.filter((f) => folderOn[f.absPath]).map((f) => ({ absPath: f.absPath })),
          })
          setNote(
            L('已提交 ', 'Committed ') +
              result.files +
              L(' 个文件，', ' files, ') +
              fmt(result.bytes) +
              (result.groups && result.groups.length > 1
                ? L(`，分成 ${result.groups.length} 个仓库`, `, across ${result.groups.length} repositories`)
                : '') +
              (result.commit ? L('，提交 ', ', commit ') + String(result.commit).slice(0, 7) : ''),
          )
          setCompare(null)
          await loadHistory()
        })

      /** Default ticks: everything the remote has that this machine lacks or differs on. */
      const buildSelection = (comparison) => {
        const sel = { plugins: {}, config: {}, folders: {} }
        const pick = (bucket, key) => {
          sel[bucket][key] = true
        }
        for (const item of comparison.plugins.install || []) pick('plugins', item.name)
        for (const item of comparison.plugins.differ || []) pick('plugins', item.name)
        for (const item of comparison.config.differ || []) pick('config', item.relPath)
        for (const item of comparison.config.missingLocal || []) pick('config', item.relPath)
        for (const item of comparison.files.unknown || []) pick('folders', item.id)
        for (const item of comparison.files.differ || []) pick('folders', item.id)
        return sel
      }

      const applySelection = async (selection) => {
        const payload = {
          confirm: true,
          plugins: Object.keys(selection.plugins).filter((k) => selection.plugins[k]),
          config: Object.keys(selection.config).filter((k) => selection.config[k]),
          folders: Object.keys(selection.folders).filter((k) => selection.folders[k]),
        }
        const result = await call('apply', payload)
        const applied =
          result.plugins.filter((r) => String(r.status).startsWith('installed')).length +
          result.config.filter((r) => r.status === 'applied').length +
          result.folders.filter((r) => r.status === 'applied').length
        const refused = result.folders.filter((r) => r.status !== 'applied').length
        const conflicts = result.folders.reduce(
          (sum, r) => sum + (r.conflicts?.length || 0) + (r.keptLocal?.length || 0),
          0,
        )
        const backedUp = result.folders.reduce((sum, r) => sum + (r.backedUp || 0), 0)
        setNote(
          L('已拉取，应用到本机 ', 'Pulled — applied here: ') +
            applied +
            L(' 项。', ' items.') +
            (refused ? L(` ${refused} 个文件夹被跳过，见清单。`, ` ${refused} folder(s) skipped, see the list.`) : '') +
            (conflicts
              ? L(
                  ` 有 ${conflicts} 个文件本机改过，没有覆盖。`,
                  ` ${conflicts} locally edited file(s) were left alone.`,
                )
              : '') +
            (backedUp ? L(` 覆盖/删除前备份了 ${backedUp} 个文件：${result.backupDir}`, ` Backed up ${backedUp} file(s) to ${result.backupDir}`) : '') +
            (result.restart && result.restart.length ? L(' 需重启 DSH 生效。', ' Restart DSH to activate.') : ''),
        )
        setPre(null)
        // Keep the list as a record; clear the ticks so nothing looks pending.
        setApplySel({ plugins: {}, config: {}, folders: {} })
        await loadHistory()
      }

      /**
       * Read the remote manifest and rebuild the list. Never writes here.
       * Returns `{ comparison, sel }`, or null when no manifest exists yet.
       */
      const refreshComparison = async () => {
        const result = await call('compare', { folders: folders.map((f) => ({ absPath: f.absPath })) })
        if (!result.exists) {
          setCompare(null)
          setNote(L('远端还没有清单，先提交一次。', 'No manifest on the remote yet — commit first.'))
          return null
        }
        setCompare(result.comparison)
        const sel = buildSelection(result.comparison)
        setApplySel(sel)
        return { comparison: result.comparison, sel }
      }

      /** Re-read only: refreshes the list and touches nothing on disk. */
      const doReload = () =>
        run('compare', async () => {
          const got = await refreshComparison()
          if (!got) return
          const counts =
            Object.keys(got.sel.plugins).length + Object.keys(got.sel.config).length + Object.keys(got.sel.folders).length
          setNote(
            counts
              ? L('清单已刷新，尚未应用。', 'List refreshed — nothing applied yet.')
              : L('已是最新。', 'Already up to date.'),
          )
        })

      /**
       * One button: compare, then apply.
       *
       * The list is still the logic — it is built from the comparison and stays
       * on screen. The only interruption kept is the path preflight, and only
       * when a folder would be created at level 3 or refused; an ordinary pull
       * onto existing paths runs straight through.
       */
      const doPull = () =>
        run('pull', async () => {
          const got = await refreshComparison()
          if (!got) return
          const { comparison, sel } = got

          const folderIds = Object.keys(sel.folders)
          const counts = Object.keys(sel.plugins).length + Object.keys(sel.config).length + folderIds.length
          if (!counts) {
            setNote(L('已是最新。', 'Already up to date.'))
            return
          }

          if (folderIds.length) {
            const source = [].concat(comparison.files.unknown || [], comparison.files.differ || [])
            const items = folderIds
              .map((id) => source.find((entry) => entry.id === id))
              .filter(Boolean)
              .map((entry) => ({ id: entry.id, absPath: entry.absPath, rootId: entry.rootId, relPath: entry.relPath }))
            const preflight = await call('preflight', { items })
            const risky = preflight.results.some((r) => !r.writable || r.level === 3)
            if (risky) {
              setPre({ results: preflight.results, pending: sel })
              return
            }
          }

          await applySelection(sel)
        })

      /** Apply whatever is ticked right now (the list's own button). */
      const applyTicked = () => run('pull', async () => await applySelection(applySel))

      const plugins = scan && scan.plugins ? scan.plugins : { items: [], bytes: 0 }
      const config = scan && scan.config ? scan.config : { items: [], bytes: 0 }
      const folderScan = scan && scan.files && scan.files.folders ? scan.files.folders : []

      /** `gitee:owner/repo` for a set, or a hint that nothing is configured. */
      const targetText = (set) => {
        const targets = state && state.resolved ? state.resolved[set] : null
        if (!targets || !targets.repo) return L('未配置仓库', 'no repository')
        return `${targets.platform === 'gitee' ? 'gitee' : 'github'}:${targets.repo}`
      }

      return h(
        'div',
        { className: 'rp-root', style: { maxWidth: '100%' } },

        embedded
          ? null
          : h(
              'div',
              { className: 'rp-tab-head' },
              h(Icon, { size: 16 }),
              h('span', { className: 'rp-tab-title' }, state && state.repo ? state.repo : L('未配置仓库', 'No repository')),
              state && state.branch ? h('span', { className: 'rp-mono' }, state.branch) : null,
            ),

        h(
          Card,
          {
            title: L('插件', 'Plugins'),
            id: 'plugins',
            right: h('span', { className: 'rp-mono' }, `${plugins.items.length} · ${fmt(plugins.bytes)}`),
          },
          plugins.items.length === 0
            ? h('div', { className: 'rp-hint' }, L('没有第三方插件。', 'No third-party plugins.'))
            : h(
                'div',
                { className: 'rp-list' },
                plugins.items.map((item) => {
                  const sel = plug[item.name] || { on: true, carry: false }
                  return h(
                    'div',
                    { key: item.name, className: 'rp-item' },
                    h('input', {
                      type: 'checkbox',
                      checked: sel.on,
                      onChange: (e) => setPlug({ ...plug, [item.name]: { ...sel, on: e.target.checked } }),
                    }),
                    h('span', { className: 'rp-name', title: item.name }, item.name),
                    h('span', { className: 'rp-mono' }, item.version),
                    h(Badge, { tone: item.kind === 'source' ? 'warn' : 'muted' }, item.kind),
                    h('span', { className: 'rp-mono' }, fmt(item.bytes)),
                    item.kind === 'registry' && item.heavy
                      ? h(
                          Btn,
                          {
                            className: 'icon',
                            title: sel.carry ? L('携带：把包放进仓库', 'Carry: store the package') : L('重装：只记版本号', 'Reinstall: record the version only'),
                            onClick: () => setPlug({ ...plug, [item.name]: { ...sel, carry: !sel.carry } }),
                          },
                          sel.carry ? '↓' : '↺',
                        )
                      : null,
                  )
                }),
              ),
          plugins.items.some((i) => i.heavy)
            ? h('div', { className: 'rp-hint' }, L('↺ 重装（只记版本）· ↓ 携带（把包放进仓库）', '↺ reinstall (version only) · ↓ carry (store the package)'))
            : null,
          h('div', { className: 'rp-hint' }, L('目标：', 'Target: ') + targetText('plugins')),
        ),

        h(
          Card,
          {
            title: L('配置', 'Configuration'),
            id: 'config',
            right: h('span', { className: 'rp-mono' }, `${config.items.length} · ${fmt(config.bytes)}`),
          },
          h(
            'div',
            { className: 'rp-list' },
            config.items.map((item) =>
              h(
                'div',
                { key: item.relPath, className: 'rp-item' },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(cfg[item.relPath]),
                  onChange: (e) => setCfg({ ...cfg, [item.relPath]: e.target.checked }),
                }),
                h('span', { className: 'rp-name' }, item.relPath),
                h('span', { className: 'rp-mono' }, fmt(item.bytes)),
              ),
            ),
          ),
          h(
            'div',
            { className: 'rp-hint' },
            L('package.json 里的 file: 路径在还原时会被改写为相对路径。', 'file: paths in package.json are rewritten to relative paths when restoring.'),
          ),
          h('div', { className: 'rp-hint' }, L('目标：', 'Target: ') + targetText('config')),
        ),

        h(
          Card,
          {
            title: L('文件夹', 'Folders'),
            id: 'folders',
            right: h('span', { className: 'rp-mono' }, String(folders.length)),
          },
          folders.length === 0
            ? h('div', { className: 'rp-hint' }, L('还没有选择文件夹。', 'No folders selected yet.'))
            : h(
                'div',
                { className: 'rp-list' },
                folders.map((folder) => {
                  const info = folderScan.find((entry) => entry.absPath.toLowerCase() === folder.absPath.toLowerCase())
                  const managed = info && info.gitManaged
                  return h(
                    'div',
                    { key: folder.absPath, className: 'rp-item' },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(folderOn[folder.absPath]) && !managed,
                      disabled: Boolean(managed),
                      onChange: (e) => setFolderOn({ ...folderOn, [folder.absPath]: e.target.checked }),
                    }),
                    h('span', { className: 'rp-name', title: folder.absPath }, folder.absPath),
                    managed
                      ? h(Badge, { tone: 'warn' }, L('受 Git 管理', 'Git-managed'))
                      : info
                        ? h('span', { className: 'rp-mono' }, `${info.fileCount} · ${fmt(info.bytes)}`)
                        : null,
                    h(
                      Btn,
                      { className: 'icon', onClick: () => setFolders(folders.filter((f) => f.absPath !== folder.absPath)) },
                      '×',
                    ),
                  )
                }),
              ),
          h(
            'div',
            { className: 'rp-wrap' },
            h('input', {
              className: 'rp-input',
              style: { flex: '1 1 200px' },
              value: newFolder,
              placeholder: (state && state.roots && state.roots[0] && state.roots[0].path) || 'D:\\work\\notes',
              onChange: (e) => setNewFolder(e.target.value),
            }),
            h(
              Btn,
              {
                onClick: () => {
                  const value = newFolder.trim()
                  if (!value) return
                  if (folders.some((f) => f.absPath.toLowerCase() === value.toLowerCase())) return
                  setFolders(folders.concat([{ absPath: value }]))
                  setNewFolder('')
                },
              },
              L('添加', 'Add'),
            ),
          ),
          h('div', { className: 'rp-hint' }, L('目标：', 'Target: ') + targetText('files')),
        ),

        compare ? h(CompareView, { compare, applySel, setApplySel, busy, onApply: applyTicked, onReload: doReload }) : null,

        h(HistoryCard, { entries: history, busy, onReload: loadHistory, ready: historyReady }),

        h(Status, { error, note }),

        h(
          'div',
          { className: 'rp-footer' },
          h(
            Btn,
            {
              primary: true,
              disabled: busy,
              onClick: doUpload,
              title: L('把选中的插件、配置和文件夹提交到仓库（一次一个 commit）', 'Commit the selected plugins, configuration and folders to the repository (one commit)'),
            },
            L('提交合并', 'Commit & push'),
          ),
          h(
            Btn,
            {
              disabled: busy,
              onClick: doPull,
              title: L('比对远端清单并直接拉取到本机；涉及新建目录时先确认路径', 'Compare against the remote and pull here; a folder that must be created asks first'),
            },
            L('拉取', 'Pull'),
          ),
          h('span', { className: 'rp-spacer' }),
          busy ? h('span', { className: 'rp-hint' }, busy) : null,
          h(Btn, { onClick: () => doScan(folders), disabled: busy }, L('刷新', 'Refresh')),
        ),

        pre
          ? h(PreflightDialog, {
              pre,
              onCancel: () => setPre(null),
              onConfirm: () => run('pull', () => applySelection(pre.pending)),
            })
          : null,
      )
    }

    // ----------------------------------------------------- comparison ui ---
    function CompareView({ compare, applySel, setApplySel, onApply, onReload, busy }) {
      ensureCss()
      const toggle = (bucket, key, on) => setApplySel({ ...applySel, [bucket]: { ...applySel[bucket], [key]: on } })
      const ticked =
        Object.keys(applySel.plugins).length + Object.keys(applySel.config).length + Object.keys(applySel.folders).length

      const group = (bucket, title, rows, label, sub) =>
        rows.length
          ? h(
              'div',
              { className: 'rp-field' },
              h('div', { className: 'rp-label' }, `${title} (${rows.length})`),
              h(
                'div',
                { className: 'rp-list' },
                rows.map((row) =>
                  h(
                    'div',
                    { key: label(row), className: 'rp-item' },
                    h('input', {
                      type: 'checkbox',
                      checked: Boolean(applySel[bucket][label(row)]),
                      onChange: (e) => toggle(bucket, label(row), e.target.checked),
                    }),
                    h('span', { className: 'rp-name' }, label(row)),
                    h('span', { className: 'rp-mono' }, sub(row)),
                  ),
                ),
              ),
            )
          : null

      return h(
        Card,
        {
          title: L('比对清单', 'Comparison'),
          id: 'compare',
          right: h(
            'div',
            { className: 'rp-wrap' },
            onReload ? h(Btn, { disabled: busy, onClick: onReload, title: L('只读远端刷新清单，不改本机', 'Refresh the list from the remote; nothing is written') }, L('重新比对', 'Re-check')) : null,
            ticked && onApply
              ? h(Btn, { disabled: busy, onClick: onApply }, L(`应用勾选 (${ticked})`, `Apply ticked (${ticked})`))
              : null,
          ),
        },
        h(
          'div',
          { className: 'rp-hint' },
          L(
            '这份清单来自上一次拉取。「重新比对」只刷新它，不动本机；「应用勾选」写入勾选的条目。',
            'This list came from the last pull. "Re-check" only refreshes it; "Apply ticked" writes the ticked entries.',
          ),
        ),
        group('plugins', L('待安装 / 版本不同', 'To install / differing'), [].concat(compare.plugins.install || [], compare.plugins.differ || []), (r) => r.name, (r) => r.remoteVersion || r.version || ''),
        group('config', L('配置差异', 'Configuration'), [].concat(compare.config.differ || [], compare.config.missingLocal || []), (r) => r.relPath, (r) => r.remote || ''),
        folderGroup(compare, applySel, toggle),
      )
    }

    /** A folder row plus the files that differ inside it. */
    function folderGroup(compare, applySel, toggle) {
      const rows = [].concat(compare.files.unknown || [], compare.files.differ || [])
      if (!rows.length) return null

      const mark = { added: '+', changed: '~', removed: '−' }
      const lines = (row) => {
        const diff = row.diff
        if (!diff || !diff.supported) return []
        const out = []
        for (const kind of ['added', 'changed', 'removed']) {
          for (const file of diff[kind] || []) out.push({ kind, relPath: file.relPath, bytes: file.bytes })
        }
        return out
      }

      return h(
        'div',
        { className: 'rp-field' },
        h('div', { className: 'rp-label' }, `${L('远端文件夹', 'Remote folders')} (${rows.length})`),
        h(
          'div',
          { className: 'rp-list' },
          rows.map((row) => {
            const all = lines(row)
            const counts = row.diff?.counts || {}
            const summary = !row.diff
              ? ''
              : all.length
              ? `+${counts.added || 0} ~${counts.changed || 0} −${counts.removed || 0}`
              : row.diff.supported
              ? L('无差异', 'no changes')
              : L('旧索引，只有整棵树', 'old index, tree-level only')
            return h(
              'div',
              { key: row.relPath || row.id, className: 'rp-diff' },
              h(
                'div',
                { className: 'rp-item' },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(applySel.folders && applySel.folders[row.id]),
                  onChange: (e) => toggle('folders', row.id, e.target.checked),
                }),
                h('span', { className: 'rp-name' }, row.relPath || row.id),
                h('span', { className: 'rp-mono' }, summary),
              ),
              all.length
                ? h(
                    'div',
                    { className: 'rp-log-paths' },
                    all.slice(0, 8).map((file) =>
                      h('span', { key: `${file.kind}:${file.relPath}` }, `${mark[file.kind]} ${file.relPath}`),
                    ),
                    all.length > 8
                      ? h(
                          'span',
                          { style: { color: 'var(--dsw-alias-label-secondary,#9a9a9a)' } },
                          L(`… 另有 ${all.length - 8} 个`, `… ${all.length - 8} more`),
                        )
                      : null,
                  )
                : null,
            )
          }),
        ),
      )
    }

    // ------------------------------------------------------ preflight ui ---
    function PreflightDialog({ pre, onCancel, onConfirm }) {
      ensureCss()
      const blocked = pre.results.filter((r) => !r.writable)
      const okCount = pre.results.length - blocked.length
      const partial = blocked.length > 0 && okCount > 0

      return h(
        'div',
        { className: 'rp-overlay', onClick: onCancel },
        h(
          'div',
          { className: 'rp-dialog', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'rp-h1' }, L('确认写入位置', 'Confirm write targets')),
          h(
            'div',
            { className: 'rp-hint' },
            L(
              '第 3 级表示目录尚不存在，确认后会一并新建。被拒绝的条目不会被写入。',
              'Level 3 means the folder does not exist yet and will be created on confirm. Refused entries are never written.',
            ),
          ),
          pre.results.map((r) =>
            h(
              'div',
              { key: r.id, className: 'rp-pre-row' },
              h(
                'div',
                { className: 'rp-row', style: { justifyContent: 'space-between' } },
                h(Badge, { tone: r.writable ? (r.level === 3 ? 'warn' : 'ok') : 'danger' }, `L${r.level}${r.writable ? '' : ' · ' + (r.conflict || 'blocked')}`),
                h('span', { className: 'rp-mono' }, r.id),
              ),
              h('div', { className: 'rp-pre-path' }, r.resolved || r.absPath || '—'),
              r.reason ? h('div', { className: 'rp-hint', style: { color: '#f85149' } }, r.reason) : null,
            ),
          ),
          h(
            'div',
            { className: 'rp-wrap', style: { justifyContent: 'flex-end' } },
            h(Btn, { onClick: onCancel }, L('取消', 'Cancel')),
            h(
              Btn,
              { primary: true, disabled: okCount === 0, onClick: onConfirm },
              partial
                ? L(`确认应用（跳过 ${blocked.length} 项）`, `Apply, skipping ${blocked.length}`)
                : L('确认应用', 'Apply'),
            ),
          ),
          okCount === 0
            ? h('div', { className: 'rp-hint', style: { color: '#f85149' } }, L('全部被拒绝，需先处理。', 'All targets were refused; resolve them first.'))
            : partial
              ? h(
                  'div',
                  { className: 'rp-hint' },
                  L(
                    '被拒绝的多半是「目录已存在但不是本插件建的」。换一个目录，或先把它移走再拉取。',
                    'A refused target is usually a directory this plugin did not create. Pick another path, or move it aside and pull again.',
                  ),
                )
              : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      // Exposed for the render smoke tests; the loader ignores extra fields.
      __test: { RepotPanel, RepotSettings, CompareView, PreflightDialog, HistoryCard, css: CSS },
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'repot', order: 50, label: () => L('环境搬运', 'Environment carry') },
            RepotSettings,
          ),
        )

        // Optional surface: the sidebar owns day-to-day operations when present.
        // Three ways to reach the service, because the client context shape
        // differs across Host versions; the first that answers wins.
        const registerTab = (sidebar) => {
          if (!sidebar || typeof sidebar.registerTab !== 'function') return false
          try {
            sidebar.registerTab({
              id: 'repot',
              title: () => 'Repot',
              description: () => L('把 DSH 环境从一台机器搬到另一台', 'Carry a DSH environment between machines'),
              icon: Icon,
              order: 40,
              single: true,
              component: RepotPanel,
            })
            return true
          } catch {
            return false
          }
        }

        let sidebar
        try {
          if (typeof ctx.get === 'function') sidebar = ctx.get('betterSidebar')
        } catch {
          sidebar = undefined
        }
        if (!sidebar) {
          try {
            sidebar = ctx.betterSidebar
          } catch {
            sidebar = undefined
          }
        }

        if (!registerTab(sidebar) && typeof ctx.inject === 'function') {
          try {
            ctx.inject(['betterSidebar'], (inner) => {
              try {
                registerTab(inner.betterSidebar)
              } catch {
                /* service absent in that scope */
              }
            })
          } catch {
            /* no injectable service; the settings page carries the feature */
          }
        }
      },
    }
  },
})
