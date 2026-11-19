/**
 * dsh-archiver —— 浏览器半端（设置里的「归档备份」一页）
 * ============================================================================
 * client bundle 不是 ESM，是自注册脚本：
 *
 *     window.__ModuleLoader__.load({
 *       id: 'dsh-archiver',                 // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject, apply }),
 *     })
 *
 * 注册设置入口（和别的第三方插件一致）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'dsh-archiver', order: 33, label: '归档备份' },
 *       () => h(Panel),
 *     ))
 *
 * ⚠️ inject 只写真正用到的服务：少写一个 → apply 里一访问就抛
 *    `cannot get property "x" without inject` → entry 判定 failed → 宿主启动即崩。
 *    这一页只用 slots，所以 inject 就是 ['slots']。
 *
 * 页面本身不写死字段：字段表从 /api/dsh-archiver?view=boot 拿（lib/schema.mjs），
 * 加设置项不需要改这里。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-archiver',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const BASE = '/api/dsh-archiver'

    /* ─────────────── 小工具 ─────────────── */

    const getPath = (obj, path) => {
      let cur = obj
      for (const p of String(path || '').split('.').filter(Boolean)) {
        if (cur === null || typeof cur !== 'object') return undefined
        cur = cur[p]
      }
      return cur
    }

    const setPath = (obj, path, value) => {
      const parts = String(path || '').split('.').filter(Boolean)
      const out = { ...(obj || {}) }
      let cur = out
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]
        cur[key] = { ...(cur[key] || {}) }
        cur = cur[key]
      }
      if (parts.length) cur[parts[parts.length - 1]] = value
      return out
    }

    const fmtBytes = (n) => {      const v = Number(n) || 0
      if (v < 1024) return `${v} B`
      if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`
      if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`
      return `${(v / 1073741824).toFixed(2)} GB`
    }

    const fmtTime = (iso) => {
      if (!iso) return '—'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return String(iso)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }

    const fmtRelative = (iso) => {
      if (!iso) return ''
      const t = new Date(iso).getTime()
      if (Number.isNaN(t)) return ''
      const diff = t - Date.now()
      const abs = Math.abs(diff)
      const unit = abs < 60_000 ? ['秒', 1000] : abs < 3_600_000 ? ['分钟', 60_000] : abs < 86_400_000 ? ['小时', 3_600_000] : ['天', 86_400_000]
      const n = Math.round(abs / unit[1])
      return diff >= 0 ? `${n} ${unit[0]}后` : `${n} ${unit[0]}前`
    }

    /** 落地位置的人话名（按钮、横幅、状态都用它，保证口径一致） */
    const DEST_LABEL = { local: '本地', webdav: '云端（WebDAV）', both: '本地 + 云端' }
    const destLabel = (d) => DEST_LABEL[d] || String(d || '?')

    const fmtValue = (field, raw) => {
      if (field.type === 'textarea') return Array.isArray(raw) ? raw.join('\n') : String(raw ?? '')
      return raw === undefined || raw === null ? '' : String(raw)
    }

    const parseValue = (field, text) => {
      if (field.type === 'textarea') {
        return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      }
      if (field.type === 'number') {
        const raw = String(text ?? '').trim()
        // 空着就让它空着（以前一清空就变 0，想重填时很难受）；保存时后端会按范围钳好
        if (raw === '') return ''
        const n = Number(raw)
        return Number.isFinite(n) ? n : ''
      }
      if (field.type === 'bool') return Boolean(text)
      return String(text ?? '')
    }

    async function api(path, init) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), init?.timeoutMs || 20000)
      try {
        const { timeoutMs, ...rest } = init || {}
        const res = await fetch(BASE + path, {
          credentials: 'same-origin',
          signal: ctl.signal,
          ...rest,
          headers: { 'content-type': 'application/json', ...(rest.headers || {}) },
        })
        const text = await res.text()
        let data = null
        try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
        if (!res.ok) {
          const detail = data?.message || data?.error || text.slice(0, 160) || res.statusText
          throw new Error(`HTTP ${res.status}：${detail}`)
        }
        return data
      } catch (e) {
        if (e?.name === 'AbortError') throw new Error('请求超时：插件后端没响应（看 log/archiver.log）')
        if (e instanceof TypeError) throw new Error(`连不上插件后端（${BASE}）：${e.message}`)
        throw e
      } finally {
        clearTimeout(timer)
      }
    }

    const CSS = `
[data-ar]{display:flex;flex-direction:column;gap:14px;padding:2px 2px 16px;max-width:760px;}
[data-ar-card]{border:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.22));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
[data-ar-h]{display:flex;align-items:center;justify-content:space-between;gap:10px;}
[data-ar-title]{font-size:14px;font-weight:600;}
[data-ar-sub]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ar-sub][data-warn]{color:#c2410c;}
[data-ar-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}
[data-ar-stat]{display:flex;flex-direction:column;gap:2px;}
[data-ar-stat-k]{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ar-stat-v]{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;}
[data-ar-field]{display:flex;gap:12px;align-items:flex-start;padding:6px 0;border-top:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.14));}
[data-ar-field]:first-of-type{border-top:0;}
[data-ar-meta]{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
[data-ar-label]{font-size:13px;}
[data-ar-help]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ar-ctrl]{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-width:0;}
[data-ar-input]{box-sizing:border-box;width:240px;max-width:100%;font:inherit;font-size:12px;padding:6px 8px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.3));background:var(--dsw-alias-bg-secondary,transparent);color:inherit;}
[data-ar-input][data-ar-num]{width:110px;}
[data-ar-input]:focus{outline:2px solid var(--dsw-alias-interactive-bg-hover,rgba(59,130,246,.45));outline-offset:1px;}
[data-ar-ta]{box-sizing:border-box;width:280px;font:inherit;font-size:12px;line-height:18px;padding:6px 8px;border-radius:8px;resize:vertical;
  border:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.3));background:var(--dsw-alias-bg-secondary,transparent);color:inherit;}
[data-ar-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;padding:0;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;}
[data-ar-sw][data-on]{background:#3b82f6;}
[data-ar-sw]::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;}
[data-ar-sw][data-on]::after{left:19px;}
[data-ar-btn]{font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-primary,rgba(128,128,128,.32));background:transparent;color:inherit;}
[data-ar-btn]:disabled{opacity:.5;cursor:default;}
[data-ar-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-ar-btn][data-danger]{color:#e2534b;border-color:rgba(226,83,75,.5);}
[data-ar-row]{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
[data-ar-pill]{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.16));}
[data-ar-toast]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.14));}
[data-ar-toast][data-err]{color:#e2534b;background:rgba(226,83,75,.12);}
/* 顶部大横幅：成功绿 / 失败红，字号比正文大，新手一眼能看到结论 */
[data-ar-fb]{border:2px solid rgba(226,83,75,.55);border-left-width:6px;border-radius:12px;padding:14px 16px;
  display:flex;flex-direction:column;gap:6px;background:rgba(226,83,75,.10);}
[data-ar-fb][data-ok]{border-color:rgba(34,160,90,.55);background:rgba(34,160,90,.10);}
[data-ar-fb-head]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-ar-fb-ico]{flex:none;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
  font-weight:700;font-size:13px;line-height:1;color:#fff;background:#e2534b;}
[data-ar-fb][data-ok] [data-ar-fb-ico]{background:#22a05a;}
[data-ar-fb-title]{font-size:15px;font-weight:700;}
[data-ar-fb-line]{font-size:12.5px;line-height:19px;word-break:break-all;}
[data-ar-fb-hint]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;background:rgba(128,128,128,.14);}
[data-ar-list]{max-height:240px;overflow:auto;display:flex;flex-direction:column;gap:4px;font-size:12px;}
[data-ar-li]{display:flex;gap:8px;justify-content:space-between;align-items:baseline;}
[data-ar-li-name]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-ar-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;
  max-height:200px;overflow:auto;background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.1));border-radius:8px;padding:8px;margin:0;}
`

    /* ─────────────── 字段控件 ─────────────── */

    function Field({ field, value, onChange }) {
      const text = fmtValue(field, value)
      if (field.type === 'bool') {
        return h('div', { 'data-ar-field': '' },
          h('div', { 'data-ar-meta': '' },
            h('div', { 'data-ar-label': '' }, field.label),
            field.help ? h('div', { 'data-ar-help': '' }, field.help) : null),
          h('div', { 'data-ar-ctrl': '' },
            h('button', {
              type: 'button',
              'data-ar-sw': '',
              'data-on': Boolean(value) ? '' : undefined,
              'aria-pressed': Boolean(value),
              'aria-label': field.label,
              onClick: () => onChange(!value),
            })))
      }
      if (field.type === 'select') {
        return h('div', { 'data-ar-field': '' },
          h('div', { 'data-ar-meta': '' },
            h('div', { 'data-ar-label': '' }, field.label),
            field.help ? h('div', { 'data-ar-help': '' }, field.help) : null),
          h('div', { 'data-ar-ctrl': '' },
            h('select', {
              'data-ar-input': '',
              value: text,
              onChange: (e) => onChange(parseValue(field, e.target.value)),
            }, (field.options || []).map(([v, label]) => h('option', { key: v, value: v }, label)))))
      }
      if (field.type === 'textarea') {
        return h('div', { 'data-ar-field': '' },
          h('div', { 'data-ar-meta': '' },
            h('div', { 'data-ar-label': '' }, field.label),
            field.help ? h('div', { 'data-ar-help': '' }, field.help) : null),
          h('div', { 'data-ar-ctrl': '' },
            h('textarea', {
              'data-ar-ta': '',
              rows: field.rows || 4,
              value: text,
              placeholder: field.placeholder || '',
              onChange: (e) => onChange(parseValue(field, e.target.value)),
            })))
      }
      const isNum = field.type === 'number'
      return h('div', { 'data-ar-field': '' },
        h('div', { 'data-ar-meta': '' },
          h('div', { 'data-ar-label': '' }, field.label),
          field.help ? h('div', { 'data-ar-help': '' }, field.help) : null),
        h('div', { 'data-ar-ctrl': '' },
          h('input', {
            'data-ar-input': '',
            ...(isNum ? { 'data-ar-num': '' } : {}),
            type: isNum ? 'number' : (field.type === 'password' ? 'password' : 'text'),
            value: text,
            min: field.min,
            max: field.max,
            step: field.step,
            placeholder: field.placeholder || '',
            onChange: (e) => onChange(parseValue(field, e.target.value)),
          }),
          field.unit ? h('span', { 'data-ar-sub': '' }, field.unit) : null))
    }

    /* ─────────────── 面板 ─────────────── */

    function Panel() {
      const [boot, setBoot] = useState(null)
      const [config, setConfig] = useState(null)
      const [status, setStatus] = useState(null)
      const [dirty, setDirty] = useState({})
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      // 面板顶部的大横幅：{ ok, title, lines:[], hint, at }
      const [fb, setFb] = useState(null)
      const fbRef = useRef(null)
      const [busy, setBusy] = useState('')
      const [runTargets, setRunTargets] = useState('all')
      const [runDry, setRunDry] = useState(false)
      const [logs, setLogs] = useState([])
      const [showLogs, setShowLogs] = useState(false)
      // 导入：来源路径 / 扫描结果 / 勾选（key = kind:name）/ 是否覆盖
      const [impPath, setImpPath] = useState('')
      const [impScan, setImpScan] = useState(null)
      const [impSel, setImpSel] = useState({})
      const [impOverwrite, setImpOverwrite] = useState(false)
      const [impCmds, setImpCmds] = useState([])
      const mounted = useRef(true)

      useEffect(() => () => { mounted.current = false }, [])

      /** 弹一条显眼反馈，并把视图滚到横幅上（否则按钮在上、结果在下，等于没反馈） */
      const showFb = useCallback((next) => {
        setFb({ at: new Date().toISOString(), ...next })
        requestAnimationFrame(() => {
          try { fbRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) } catch { /* ignore */ }
        })
      }, [])

      const loadBoot = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const data = await api('?view=boot')
          if (!mounted.current) return
          setBoot(data.schema)
          setConfig(data.config)
          setStatus(data.status)
          setDirty({})
          setRunTargets(data.config?.manual?.defaultTargets || 'all')
          setRunDry(Boolean(data.config?.manual?.dryRun))
          // 打开面板时先把"上次 WebDAV 自检"的结论摆出来（有记录才摆）
          const wt = data.status?.webdavTest
          if (wt) {
            setFb((prev) => prev || {
              at: wt.at,
              ok: Boolean(wt.ok),
              title: wt.ok ? '上次 WebDAV 自检：通过' : '上次 WebDAV 自检：失败',
              lines: [
                `结论：${wt.message || (wt.ok ? '可用' : '失败')}`,
                wt.base ? `地址：${wt.base}` : '',
                wt.status ? `HTTP 状态：${wt.status}` : '',
              ].filter(Boolean),
              hint: wt.hint || '',
              fromState: true,
            })
          }
        } catch (e) {
          if (mounted.current) setError(String(e?.message || e))
        } finally {
          if (mounted.current) setLoading(false)
        }
      }, [])

      const refreshStatus = useCallback(async () => {
        try {
          const data = await api('?view=status')
          if (mounted.current) setStatus(data)
        } catch (e) {
          if (mounted.current) setError(String(e?.message || e))
        }
      }, [])

      useEffect(() => { loadBoot() }, [loadBoot])

      const current = useMemo(() => {
        let cfg = config || {}
        for (const [key, value] of Object.entries(dirty)) cfg = setPath(cfg, key, value)
        return cfg
      }, [config, dirty])

      const dirtyCount = Object.keys(dirty).length

      const setValue = (key, value) => {
        const base = getPath(config || {}, key)
        const same = JSON.stringify(base) === JSON.stringify(value)
        setDirty((prev) => {
          const next = { ...prev }
          if (same) delete next[key]
          else next[key] = value
          return next
        })
      }

      const save = async () => {
        if (!dirtyCount) return
        setBusy('save')
        setFb(null)
        try {
          const r = await api('?view=config', { method: 'POST', body: JSON.stringify({ action: 'config', patch: dirty }) })
          if (!mounted.current) return
          setConfig(r.config)
          setStatus(r.status)
          setDirty({})
          showFb({
            ok: Boolean(r.ok),
            title: r.ok ? `设置已保存（${r.applied.length} 项）` : '有设置没保存成功',
            lines: [
              r.applied?.length ? `已生效：${r.applied.join('、')}` : '',
              r.rejected?.length ? `被拒绝：${r.rejected.join('、')}` : '',
            ].filter(Boolean),
            hint: r.ok ? '新设置立刻生效（定时器每分钟按新配置判断一次）；只有「DSH 启动时自动归档」要重启才排期。' : '',
          })
        } catch (e) {
          if (mounted.current) showFb({ ok: false, title: '保存失败：请求没发出去', lines: [String(e?.message || e)], hint: '看 log/archiver.log；DSH 刚升级过的话先重启。' })
        } finally {
          if (mounted.current) setBusy('')
        }
      }

      /**
       * 手动归档。`dest` 由**按钮**决定，不再让人猜：
       *   local / webdav / both；空跑时只扫描不写盘（dest 仍照实带过去）。
       */
      const runNow = async (dest) => {
        setBusy(`run:${dest}`)
        setFb(null)
        try {
          const r = await api('?view=run', {
            method: 'POST',
            timeoutMs: 900000,
            body: JSON.stringify({ action: 'run', targets: runTargets, dest, dryRun: runDry, why: 'panel' }),
          })
          if (!mounted.current) return

          if (r?.code === 'BUSY') {
            showFb({ ok: false, title: '上一轮还没跑完', lines: ['同一时间只允许一个归档任务。'], hint: '等状态变成「空闲」再点一次。' })
          } else if (r?.code === 'WEBDAV_NOT_CONFIGURED') {
            showFb({
              ok: false,
              title: '没有归档：WebDAV 还没配好',
              lines: [`${r.message}`, `这次点的目标：${destLabel(dest)}`],
              hint: r.hint || '',
            })
          } else {
            const failed = (r?.errors || []).length + (r?.remote?.failed || []).length
            const counts = [
              `目标：${destLabel(dest)}${runDry ? '（空跑，不写盘）' : ''}`,
              `打包 ${r?.counts?.packaged ?? 0} 个（技能 ${(r?.skills || []).length} / 插件 ${(r?.plugins || []).length}）`,
              r?.counts?.reused ? `复用（源没变）${r.counts.reused} 个` : '',
              `压缩后共 ${fmtBytes(r?.totals?.zipBytes || 0)}`,
              (dest === 'local' || dest === 'both')
                ? (runDry ? '本地：空跑，没有写文件' : `本地写入 ${r?.local?.written ?? 0} 个 → ${r?.saveRoot || '(保存目录未知)'}`)
                : '',
              (dest === 'webdav' || dest === 'both')
                ? (runDry
                  ? '云端：空跑，没有上传'
                  : `云端上传 ${r?.remote?.uploaded ?? 0} 个 → ${r?.remoteBase || '(远端地址未知)'}`)
                : '',
            ].filter(Boolean)
            const problems = [
              ...(r?.errors || []).slice(0, 3).map((e) => `✗ ${e.kind}:${e.name} —— ${e.error}`),
              ...(r?.remote?.failed || []).slice(0, 3).map((e) => `✗ 上传 ${e.name} —— ${e.error}`),
            ]
            showFb({
              ok: !failed,
              title: runDry
                ? (failed ? `空跑完成，但有 ${failed} 个问题` : '空跑完成（没有写盘、没有上传）')
                : (failed
                  ? `归档到${destLabel(dest)}完成，但有 ${failed} 个问题`
                  : `归档到${destLabel(dest)}成功`),
              lines: [...counts, ...problems],
              hint: failed
                ? '单个失败不影响其它包；完整清单在下面的「本地产物」和 log/archiver.log 里。'
                : (runDry ? '这次只是演练；去掉「空跑」再点一次才会真的写。' : ''),
            })
          }
          await refreshStatus()
        } catch (e) {
          if (mounted.current) showFb({ ok: false, title: '归档失败：请求没发出去', lines: [String(e?.message || e)], hint: '看 log/archiver.log；超过 15 分钟没响应会走到这里。' })
        } finally {
          if (mounted.current) setBusy('')
        }
      }

      const testWebdav = async () => {
        setBusy('webdav')
        setFb(null)
        try {
          const r = await api('?view=webdav', { method: 'POST', timeoutMs: 90000, body: JSON.stringify({ action: 'test-webdav' }) })
          if (!mounted.current) return
          showFb({
            ok: Boolean(r?.ok),
            title: r?.ok ? 'WebDAV 自检通过' : 'WebDAV 自检失败',
            lines: [
              `原因：${r?.message || (r?.ok ? '可用' : '没有返回原因')}`,
              r?.base ? `实际请求地址：${r.base}` : '',
              r?.status ? `HTTP 状态：${r.status}（代码 ${r?.code || '-'}）` : (r?.code ? `代码：${r.code}` : ''),
            ].filter(Boolean),
            hint: r?.hint || (r?.ok ? '把「默认落地位置」设成「本地 + WebDAV」，下次归档就会同时传上去。' : ''),
          })
          await refreshStatus()
        } catch (e) {
          if (mounted.current) showFb({
            ok: false,
            title: '测试没跑起来：请求没到后端',
            lines: [String(e?.message || e)],
            hint: '先点「刷新」看看面板还能不能读到状态；不行就重启 DSH（HTTP 桥是启动时挂的）。',
          })
        } finally {
          if (mounted.current) setBusy('')
        }
      }

      const openFolder = async (what) => {
        try {
          await api('?view=open', { method: 'POST', body: JSON.stringify({ action: 'open', what }) })
        } catch (e) {
          showFb({ ok: false, title: '打开失败', lines: [String(e?.message || e)], hint: '' })
        }
      }

      const loadLogs = async () => {
        try {
          const r = await api(`?view=logs&lines=80`)
          if (mounted.current) setLogs(r.lines || [])
        } catch (e) {
          if (mounted.current) setError(String(e?.message || e))
        }
      }

      /* ── 历史版本 / 导入 ── */

      const scanImport = async (pathOverride) => {
        const path = String(pathOverride ?? impPath).trim()
        setBusy('imp-scan')
        setFb(null)
        try {
          const r = await api('?view=import-scan', { method: 'POST', body: JSON.stringify({ action: 'import-scan', source: { path } }) })
          if (!mounted.current) return
          if (!r.ok) {
            setImpScan(null)
            showFb({ ok: false, title: '扫描失败', lines: [`来源：${path || '(空)'}`, r.error || ''].filter(Boolean), hint: '来源填导出目录（例如 D:\\Backup\\dsh）或历史快照目录，也可以直接填一个 .zip 的完整路径。' })
            return
          }
          setImpScan(r)
          // 默认勾选"还不存在"的那些，已存在的要用户自己决定覆盖
          const sel = {}
          for (const it of r.items || []) if (!it.exists) sel[`${it.kind}:${it.name}`] = true
          setImpSel(sel)
          showFb({
            ok: true,
            title: `扫描完成：${r.items.length} 个包`,
            lines: [
              `来源：${r.source.path}`,
              `技能会解到：${r.roots.skills}`,
              `插件会解到：${r.roots.plugins}`,
              ...(r.notes || []).slice(0, 3),
            ],
            hint: r.items.length ? '勾上要导入的，然后点「导入选中的」；已存在的默认不勾（勾了要开「覆盖」）。' : '这个来源里没找到本插件产出的技能包/插件包。',
          })
        } catch (e) {
          if (mounted.current) showFb({ ok: false, title: '扫描请求失败', lines: [String(e?.message || e)], hint: '' })
        } finally {
          if (mounted.current) setBusy('')
        }
      }

      const doImport = async () => {
        const picked = (impScan?.items || []).filter((it) => impSel[`${it.kind}:${it.name}`])
        if (!picked.length) {
          showFb({ ok: false, title: '还没有勾选任何包', lines: ['先点「扫描来源」，再勾上要导入的条目。'], hint: '' })
          return
        }
        setBusy('imp-run')
        setFb(null)
        try {
          const r = await api('?view=import', {
            method: 'POST',
            timeoutMs: 300000,
            body: JSON.stringify({ action: 'import', items: picked, overwrite: impOverwrite }),
          })
          if (!mounted.current) return
          const failed = (r?.failed || []).length
          const lines = [
            ...(r?.imported || []).map((x) => `✓ ${x.kind === 'skill' ? '技能' : '插件'} ${x.name} → ${x.target}（${x.files} 个文件${x.backup ? '，旧版本已备份为 .bak' : ''}）`),
            ...(r?.skipped || []).map((x) => `· 跳过 ${x.name}：${x.reason}`),
            ...(r?.failed || []).map((x) => `✗ ${x.name}：${x.error}`),
            ...(r?.pluginCommands || []).map((c) => `插件要生效，执行：${c}`),
          ]
          showFb({
            ok: !failed,
            title: failed
              ? `导入完成，但有 ${failed} 个失败`
              : `导入完成：成功 ${(r?.imported || []).length} 个${(r?.skipped || []).length ? `，跳过 ${r.skipped.length} 个` : ''}`,
            lines,
            hint: (r?.pluginCommands || []).length
              ? '技能会被 DSH 自动发现（一般不用重启）；插件只是解压到导入目录，需要按上面那条 link 命令装进 profile。'
              : '技能已进技能根，DSH 会自动发现。',
          })
          setImpScan({ ...(impScan || {}), items: (impScan?.items || []).map((it) => ({ ...it, exists: true })) })
          setImpCmds(r?.pluginCommands || [])
          setImpSel({})
          await refreshStatus()
        } catch (e) {
          if (mounted.current) showFb({ ok: false, title: '导入请求失败', lines: [String(e?.message || e)], hint: '看 log/archiver.log。' })
        } finally {
          if (mounted.current) setBusy('')
        }
      }

      const pruneNow = async () => {
        const keep = Math.max(0, Number(st?.history?.keep) || 0)
        setBusy('prune')
        setFb(null)
        try {
          const r = await api('?view=prune', { method: 'POST', body: JSON.stringify({ action: 'prune', keep }) })
          if (!mounted.current) return
          showFb({
            ok: true,
            title: `清理完成：保留最近 ${keep} 份`,
            lines: [
              `目录：${r.root}`,
              `删掉 ${(r.removed || []).length} 份：${(r.removed || []).join(', ') || '（没有可删的）'}`,
              (r.skipped || []).length
                ? `跳过 ${r.skipped.length} 个不是本插件写的目录（没动它们）：${r.skipped.slice(0, 3).join(', ')}`
                : '',
            ].filter(Boolean),
            hint: (r.skipped || []).length ? '只有含 archiver manifest 的快照才会被清理，别人的目录一律不碰。' : '',
          })
          await refreshStatus()
        } catch (e) {
          if (mounted.current) showFb({ ok: false, title: '清理失败', lines: [String(e?.message || e)], hint: '' })
        } finally {
          if (mounted.current) setBusy('')
        }
      }

      /** 复制到剪贴板：优先 Clipboard API，被拒时退到 textarea + execCommand */
      const legacyCopy = (text) => {
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.style.position = 'fixed'
          ta.style.top = '-1000px'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.focus()
          ta.select()
          const ok = document.execCommand('copy')
          ta.remove()
          return ok
        } catch { return false }
      }

      const copyText = async (text) => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            showFb({ ok: true, title: '命令已复制', lines: [text], hint: '把它粘到 PowerShell 里执行。' })
            return
          }
        } catch { /* 浏览器不给权限，落到兼容模式 */ }
        if (legacyCopy(text)) {
          showFb({ ok: true, title: '命令已复制（兼容模式）', lines: [text], hint: '把它粘到 PowerShell 里执行。' })
          return
        }
        showFb({ ok: false, title: '复制失败：浏览器不让写剪贴板', lines: [text], hint: '手动选中这条命令复制即可。' })
      }

      /* 渲染 */

      if (loading && !boot) {
        return h('div', { 'data-ar': '' }, h('div', { 'data-ar-sub': '' }, '读取归档器配置中…'))
      }

      if (error && !boot) {
        return h('div', { 'data-ar': '' },
          h('div', { 'data-ar-card': '' },
            h('div', { 'data-ar-title': '' }, '读不到插件后端'),
            h('div', { 'data-ar-toast': '', 'data-err': '' }, error),
            h('div', { 'data-ar-sub': '' }, '浏览器刷新一次；还不行就看 $DSH_HOME/dsh-archiver/log/archiver.log（HTTP 桥可能没挂上）。'),
            h('div', { 'data-ar-row': '' },
              h('button', { 'data-ar-btn': '', type: 'button', onClick: loadBoot }, '重试'))))
      }

      const st = status || {}
      const counts = st.counts || {}
      const last = st.lastRun || null
      const artifacts = Array.isArray(st.artifacts) ? st.artifacts : []
      const totalZip = artifacts.reduce((n, a) => n + (Number(a.bytes) || 0), 0)

      /** WebDAV 一句话状态（概览卡用） */
      const wdSummary = (() => {
        const w = st.webdav || {}
        if (!w.enabled) return '未启用'
        if (!w.url) return '缺地址'
        if (w.user && !w.hasPassword) return '缺密码'
        const t = st.webdavTest
        if (!t) return '已配置 · 未测'
        return t.ok ? `可用（${fmtTime(t.at)}）` : `上次失败：${String(t.message || t.code || '').slice(0, 24)}`
      })()

      return h('div', { 'data-ar': '' },
        // ── 概览 ──
        h('div', { 'data-ar-card': '' },
          h('div', { 'data-ar-h': '' },
            h('div', { 'data-ar-title': '' }, '归档备份'),
            h('div', { 'data-ar-row': '' },
              h('span', { 'data-ar-pill': '' }, st.running ? '正在归档…' : '空闲'),
              h('button', { 'data-ar-btn': '', type: 'button', disabled: Boolean(busy), onClick: () => { refreshStatus(); loadLogs() } }, '刷新'))),
          h('div', { 'data-ar-grid': '' },
            h('div', { 'data-ar-stat': '' },
              h('div', { 'data-ar-stat-k': '' }, '可归档'),
              h('div', { 'data-ar-stat-v': '' }, `${counts.skills ?? 0} 技能 / ${counts.plugins ?? 0} 插件`)),
            h('div', { 'data-ar-stat': '' },
              h('div', { 'data-ar-stat-k': '' }, '本地产物'),
              h('div', { 'data-ar-stat-v': '' }, `${counts.artifacts ?? 0} 个 · ${fmtBytes(totalZip)}`)),
            h('div', { 'data-ar-stat': '' },
              h('div', { 'data-ar-stat-k': '' }, '上次运行'),
              h('div', { 'data-ar-stat-v': '' }, last ? `${fmtTime(last.at)}（${last.why}）` : '还没跑过')),
            h('div', { 'data-ar-stat': '' },
              h('div', { 'data-ar-stat-k': '' }, '下次自动'),
              h('div', { 'data-ar-stat-v': '' }, st.nextRunAt ? `${fmtTime(st.nextRunAt)}` : '不会再自动跑')),
            h('div', { 'data-ar-stat': '' },
              h('div', { 'data-ar-stat-k': '' }, 'WebDAV'),
              h('div', { 'data-ar-stat-v': '' }, wdSummary))),
          st.nextRunAt ? h('div', { 'data-ar-sub': '' }, `下次自动归档：${fmtRelative(st.nextRunAt)}`) : null,
          h('div', { 'data-ar-sub': '' }, `保存目录：${st.saveRoot || '—'}`),
          h('div', { 'data-ar-row': '' },
            h('button', { 'data-ar-btn': '', type: 'button', onClick: () => openFolder('saveRoot') }, '打开保存目录'),
            h('button', { 'data-ar-btn': '', type: 'button', onClick: () => openFolder('log') }, '打开日志'),
            h('button', { 'data-ar-btn': '', type: 'button', onClick: () => openFolder('config') }, '打开配置文件'))),

        // ── 顶部大横幅：点完按钮立刻能看见结论 ──
        fb
          ? h('div', {
            ref: fbRef,
            'data-ar-fb': '',
            'data-ok': fb.ok ? '' : undefined,
            role: 'status',
            'aria-live': 'polite',
            key: 'fb',
          },
          h('div', { 'data-ar-fb-head': '' },
            h('span', { 'data-ar-fb-ico': '', 'aria-hidden': 'true' }, fb.ok ? '✓' : '✗'),
            h('span', { 'data-ar-fb-title': '' }, fb.ok ? '成功 · ' : '没有成功 · ', fb.title),
            h('span', { 'data-ar-sub': '' }, fmtTime(fb.at))),
          (fb.lines || []).filter(Boolean).map((line, i) => h('div', { 'data-ar-fb-line': '', key: `l${i}` }, line)),
          fb.hint ? h('div', { 'data-ar-fb-hint': '' }, `👉 ${fb.hint}`) : null,
          h('div', { 'data-ar-row': '' },
            h('button', { 'data-ar-btn': '', type: 'button', onClick: () => setFb(null) }, '知道了')))
          : null,

        error
          ? h('div', { 'data-ar-toast': '', 'data-err': '', role: 'alert', key: 'err' }, `面板和后端通信出错：${error}`)
          : null,

        // ── 立即归档（手动）：按钮按"落到哪儿"分开，不让人猜 ──
        h('div', { 'data-ar-card': '' },
          h('div', { 'data-ar-title': '' }, '立即归档（手动）'),
          h('div', { 'data-ar-sub': '' },
            `按目标点按钮：写本地、传云端，或者两边都做。这里的选择只作用于这一次；自动归档用下面「默认落地位置」（当前：${destLabel(st.dest)}）。`),
          h('div', { 'data-ar-row': '' },
            h('span', { 'data-ar-sub': '' }, '归档对象'),
            h('select', {
              'data-ar-input': '',
              value: runTargets,
              onChange: (e) => setRunTargets(e.target.value),
            },
            h('option', { value: 'all' }, '技能 + 插件'),
            h('option', { value: 'skills' }, '只技能'),
            h('option', { value: 'plugins' }, '只插件')),
            h('label', { 'data-ar-row': '', style: { fontSize: 12, gap: 6 } },
              h('input', {
                type: 'checkbox',
                checked: runDry,
                onChange: (e) => setRunDry(e.target.checked),
              }),
              '空跑（只扫描，不写盘不上传）')),
          h('div', { 'data-ar-row': '' },
            h('button', {
              'data-ar-btn': '',
              'data-primary': '',
              type: 'button',
              disabled: Boolean(busy),
              onClick: () => runNow('local'),
            }, busy === 'run:local' ? '正在写本地…' : `归档到本地（${st.saveRoot ? '保存目录' : 'out'}）`),
            h('button', {
              'data-ar-btn': '',
              type: 'button',
              disabled: Boolean(busy),
              onClick: () => runNow('webdav'),
            }, busy === 'run:webdav' ? '正在传云端…' : '归档到云端（WebDAV）'),
            h('button', {
              'data-ar-btn': '',
              type: 'button',
              disabled: Boolean(busy),
              onClick: () => runNow('both'),
            }, busy === 'run:both' ? '正在本地 + 云端…' : '本地 + 云端'),
            h('button', {
              'data-ar-btn': '',
              type: 'button',
              disabled: Boolean(busy),
              onClick: testWebdav,
            }, busy === 'webdav' ? '测试中…' : '测试 WebDAV')),
          h('div', { 'data-ar-sub': '' },
            `本地目录：${st.saveRoot || '—'}`),
          st.webdav?.enabled && st.webdav?.url
            ? h('div', { 'data-ar-sub': '' }, `云端目录：${st.webdav.url}${String(st.webdav.root || '').replace(/\/+$/, '') ? st.webdav.root : ''}`)
            : h('div', { 'data-ar-sub': '' }, '云端还没配好：点「归档到云端」会直接告诉你缺什么，不会偷偷只存本地。')),

        // ── 历史版本 ──
        (() => {
          const hist = st.history || {}
          const snaps = Array.isArray(hist.snapshots) ? hist.snapshots : []
          return h('div', { 'data-ar-card': '', key: 'history' },
            h('div', { 'data-ar-h': '' },
              h('div', { 'data-ar-title': '' }, `历史版本（保留 ${hist.keep ?? 0} 份 · 现有 ${snaps.length} 份）`),
              h('div', { 'data-ar-row': '' },
                h('button', { 'data-ar-btn': '', type: 'button', onClick: () => openFolder('history') }, '打开历史目录'),
                h('button', {
                  'data-ar-btn': '',
                  type: 'button',
                  disabled: Boolean(busy),
                  onClick: pruneNow,
                }, busy === 'prune' ? '清理中…' : `清理到 ${hist.keep ?? 0} 份`))),
            h('div', { 'data-ar-sub': '' }, `快照位置：${hist.root || '—'}；份数在下面「本地落地 → 保留历史版本数量」里改（0 = 只留最新）。`),
            hist.warning ? h('div', { 'data-ar-sub': '', 'data-warn': '' }, `⚠ ${hist.warning}`) : null,
            snaps.length
              ? h('div', { 'data-ar-list': '' }, snaps.map((s) => h('div', { 'data-ar-li': '', key: s.name },
                h('span', { 'data-ar-li-name': '', title: s.dir }, `${s.name}${s.at ? ` · ${fmtTime(s.at)}` : ''}`),
                h('span', { 'data-ar-row': '' },
                  h('span', { 'data-ar-sub': '' }, `${s.packaged ?? '?'} 包 · ${fmtBytes(s.bytes)}`),
                  h('button', {
                    'data-ar-btn': '',
                    type: 'button',
                    onClick: () => { setImpPath(s.dir); scanImport(s.dir) },
                  }, '导入这份')))))
              : (hist.warning
                ? null
                : h('div', { 'data-ar-sub': '' }, (hist.keep ?? 0) > 0
                  ? '还没有历史快照：下一次归档会生成第一份。'
                  : '还没开启历史版本：把「保留历史版本数量」设成 N（例如 10），再归档一次就会开始留。')))
        })(),

        // ── 导入备份 ──
        h('div', { 'data-ar-card': '', key: 'import' },
          h('div', { 'data-ar-title': '' }, '导入备份'),
          h('div', { 'data-ar-sub': '' }, '把本插件导出的备份解回来：技能进技能根（DSH 会自动发现），插件进「插件导入目录」。来源可以是导出根目录、某份历史快照，或单个 .zip。'),
          h('div', { 'data-ar-row': '' },
            h('input', {
              'data-ar-input': '',
              style: { flex: '1 1 320px', width: 'auto' },
              value: impPath,
              placeholder: '例如 D:\\Backup\\dsh  或  …\\out\\history\\20261118-140839  或  某个 .zip',
              onChange: (e) => setImpPath(e.target.value),
            }),
            h('button', {
              'data-ar-btn': '',
              'data-primary': '',
              type: 'button',
              disabled: busy === 'imp-scan',
              onClick: () => scanImport(),
            }, busy === 'imp-scan' ? '扫描中…' : '扫描来源'),
            h('button', { 'data-ar-btn': '', type: 'button', onClick: () => openFolder('importPlugins') }, '打开插件导入目录')),
          impScan
            ? h('div', {},
              h('div', { 'data-ar-sub': '' },
                `扫描到 ${impScan.items.length} 个包 · 技能→${impScan.roots?.skills || '—'} · 插件→${impScan.roots?.plugins || '—'}`),
              h('div', { 'data-ar-list': '' }, impScan.items.map((it) => {
                const key = `${it.kind}:${it.name}`
                return h('label', { 'data-ar-li': '', key, style: { gap: 8, cursor: 'pointer', alignItems: 'center' } },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(impSel[key]),
                    onChange: (e) => setImpSel((prev) => ({ ...prev, [key]: e.target.checked })),
                  }),
                  h('span', { 'data-ar-li-name': '', title: it.target }, `${it.kind === 'skill' ? '技能' : '插件'} · ${it.name}${it.version ? `@${it.version}` : ''} → ${it.target}`),
                  h('span', { 'data-ar-sub': '' }, `${fmtBytes(it.zipBytes)}${it.exists ? ' · 已存在' : ''}`))
              })),
              h('div', { 'data-ar-row': '' },
                h('label', { 'data-ar-row': '', style: { fontSize: 12, gap: 6 } },
                  h('input', {
                    type: 'checkbox',
                    checked: impOverwrite,
                    onChange: (e) => setImpOverwrite(e.target.checked),
                  }),
                  '覆盖已存在的（旧目录改名成 .bak-<时间戳> 留底，不删除）'),
                h('button', {
                  'data-ar-btn': '',
                  'data-primary': '',
                  type: 'button',
                  disabled: busy === 'imp-run',
                  onClick: doImport,
                }, busy === 'imp-run' ? '导入中…' : `导入选中的 ${Object.values(impSel).filter(Boolean).length} 个`)))
            : null,
          impCmds.length
            ? h('div', {}, h('div', { 'data-ar-sub': '' }, '插件装进 profile 的命令（点「复制」即可）：'),
              impCmds.map((c, i) => h('div', { 'data-ar-row': '', key: `cmd${i}` },
                h('code', {
                  'data-ar-mono': '',
                  title: '点一下全选，然后 Ctrl+C',
                  style: { flex: '1 1 260px', maxHeight: 'none', margin: 0, cursor: 'text' },
                  onClick: (e) => {
                    // 剪贴板可能被浏览器拦；点一下全选，Ctrl+C 一定可行
                    try {
                      const range = document.createRange()
                      range.selectNodeContents(e.currentTarget)
                      const sel = window.getSelection()
                      sel.removeAllRanges()
                      sel.addRange(range)
                    } catch { /* ignore */ }
                  },
                }, c),
                h('button', { 'data-ar-btn': '', type: 'button', onClick: () => copyText(c) }, '复制'))))
            : null,
          h('div', { 'data-ar-sub': '' }, '插件备份解出来只是源码；要生效还得按上面那条 `dsh plugin add link:<路径>` 装进 profile —— 本插件不替你改 profile / bundles。')),

        // ── 设置分组（后端没重启时 schema 是空的，给一句人话而不是空白） ──
        (boot?.groups || []).length
          ? (boot.groups || []).map((group) => h('div', { 'data-ar-card': '', key: group.id },
            h('div', { 'data-ar-title': '' }, group.title),
            group.desc ? h('div', { 'data-ar-sub': '' }, group.desc) : null,
            group.fields.map((field) => {
              // 密码不回传：已配过就提示"留空表示不修改"
              const f = (field.key === 'webdav.password' && (st.webdav?.hasPassword || st.webdav?.passwordFromEnv))
                ? { ...field, placeholder: '已设置（留空表示不修改）' }
                : field
              return h(Field, {
                key: field.key,
                field: f,
                value: getPath(current, field.key),
                onChange: (v) => setValue(field.key, v),
              })
            })))
          : h('div', { 'data-ar-card': '', key: 'no-schema' },
            h('div', { 'data-ar-title': '' }, '设置项不可用'),
            h('div', { 'data-ar-sub': '' }, '后端还是老版本（插件刚升级、DSH 还没重启）。上面的「立即归档」和状态照常用；设置项在完全退出 DSH 再启动后出现。'),
            h('div', { 'data-ar-row': '' },
              h('button', { 'data-ar-btn': '', type: 'button', onClick: loadBoot }, '再试一次'))),

        // ── 保存条 ──
        h('div', { 'data-ar-card': '' },
          h('div', { 'data-ar-row': '' },
            h('button', {
              'data-ar-btn': '',
              'data-primary': '',
              type: 'button',
              disabled: !dirtyCount || Boolean(busy),
              onClick: save,
            }, busy === 'save' ? '保存中…' : (dirtyCount ? `保存 ${dirtyCount} 项修改` : '没有改动')),
            h('button', { 'data-ar-btn': '', type: 'button', disabled: !dirtyCount, onClick: () => setDirty({}) }, '放弃修改'),
            h('button', { 'data-ar-btn': '', type: 'button', disabled: Boolean(busy), onClick: loadBoot }, '重新读取')),
          h('div', { 'data-ar-sub': '' }, '配置写在 $DSH_HOME/dsh-archiver/config.json；保存后定时器立刻按新设置算，不用重启。')),

        // ── 产物 ──
        h('div', { 'data-ar-card': '' },
          h('div', { 'data-ar-h': '' },
            h('div', { 'data-ar-title': '' }, `本地产物（${artifacts.length}）`),
            h('div', { 'data-ar-row': '' },
              h('button', { 'data-ar-btn': '', type: 'button', onClick: () => openFolder('saveRoot') }, '在资源管理器里看'))),
          artifacts.length
            ? h('div', { 'data-ar-list': '' }, artifacts.map((a) => h('div', { 'data-ar-li': '', key: a.path || a.name },
              h('span', { 'data-ar-li-name': '', title: a.path || a.name }, `${a.kind === 'skill' ? '技能' : '插件'} · ${a.name}`),
              h('span', { 'data-ar-sub': '' }, `${fmtBytes(a.bytes)} · ${fmtTime(a.mtime)}`))))
            : h('div', { 'data-ar-sub': '' }, '还没有产物。点上面「开始归档」跑一次。')),

        // ── 日志 ──
        h('div', { 'data-ar-card': '' },
          h('div', { 'data-ar-h': '' },
            h('div', { 'data-ar-title': '' }, '运行日志'),
            h('div', { 'data-ar-row': '' },
              h('button', {
                'data-ar-btn': '',
                type: 'button',
                onClick: () => { const next = !showLogs; setShowLogs(next); if (next) loadLogs() },
              }, showLogs ? '收起' : '查看最近 80 行'))),
          showLogs
            ? h('pre', { 'data-ar-mono': '' }, logs.length ? logs.join('\n') : '（日志是空的）')
            : h('div', { 'data-ar-sub': '' }, st.logFile || '$DSH_HOME/dsh-archiver/log/archiver.log')))
    }

    /* ─────────────── 注册 ─────────────── */

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        try { ctx.effect(() => () => { try { style.remove() } catch { /* ignore */ } }, 'dsh-archiver: style') } catch { /* ignore */ }

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots?.inject || !slots?.register) return

        try {
          const off = slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'dsh-archiver', order: 33, label: '归档备份' },
            () => h(Panel),
          ))
          try { ctx.effect(() => () => { try { off?.() } catch { /* ignore */ } }, 'dsh-archiver: settings') } catch { /* ignore */ }
        } catch (e) {
          console.warn('dsh-archiver: 注册设置页失败：', e)
        }
      },
    }
  },
})
