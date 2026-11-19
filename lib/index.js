/**
 * dsh-archiver —— 宿主半端
 * ============================================================================
 * 干的事：
 *   · 把 DSH 里的**每一个技能、每一个插件**各自打成一个 zip；
 *   · 落地到本地指定目录，可选同步到 WebDAV；
 *   · 触发方式：手动（设置页 / 工具 / CLI / HTTP）、定时（每 N 小时 / 每天 HH:MM）、
 *     DSH 启动后自动跑一次；
 *   · 设置页（client.js）只注册 **一个** settings.section 槽位，页面本体从
 *     /api/dsh-archiver?view=boot 拉 schema + 配置 + 状态，字段全由 lib/schema.mjs 描述。
 *
 * 关于前端：client.js 的 inject 只写真正用到的服务（'slots'），少写一个就是
 * 「页面加载即崩」，所以宁可少注册入口，也不多 require 一个服务。
 * ============================================================================
 */
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { loadDefineTool, textOutput } from './hostdeps.mjs'
import {
  loadCfg, getPath, configFile, resolveSaveRoot, applyPatch, redactConfig,
} from './config.mjs'
import { appendLog, ensureDirs, readJson, writeJson, stateDirOf, tailLog, logFile } from './state.mjs'
import { runArchive, statusReport, isRunning, testWebdav, pruneRuns } from './run.mjs'
import { autoReason } from './schedule.mjs'
import { panelSchema, fieldKeys } from './schema.mjs'
import { scanImportSource, runImport, importRoots } from './importer.mjs'
export const name = 'dsh-archiver'
export const inject = ['tools']

const TICK_MS = 60_000

/**
 * 工具输出必须是「无损 JSON」：undefined、Date、Buffer、循环引用都会被宿主的
 * 输出校验拦下（报 "value is not lossless JSON"）。这里统一过一遍 JSON 往返，
 * 顺带把 NaN/Infinity 变成 null —— 宁可少字段，也不能让整次调用报错。
 */
function lossless(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => {
      if (typeof v === 'number' && !Number.isFinite(v)) return null
      return v
    }))
  } catch {
    return { ok: false, code: 'OUTPUT_NOT_JSON', message: '结果无法序列化为 JSON' }
  }
}

/** 用系统默认方式打开一个目录/文件（只允许插件自己的几个位置） */
function openInShell(target) {
  const args = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', target]]
    : process.platform === 'darwin'
      ? ['open', [target]]
      : ['xdg-open', [target]]
  const child = spawn(args[0], args[1], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/** 按点路径批量改配置（面板保存走这条）—— 实现在 config.mjs，这里只包一层日志 */
const applyConfigPatch = (home, patch, log) => applyPatch(home, patch, log)

/**
 * 跑一次 WebDAV 自检，并把结论记进 state.json。
 * 记下来的意义：面板刷新后仍然能看到"上次测试：失败（401）—— 密码不对"，
 * 不用让人对着一个没有历史的按钮反复点。
 */
async function runWebdavTest(home, log) {
  const cfg = loadCfg(home)
  const r = await testWebdav(cfg)
  try {
    const file = join(home, 'state.json')
    const st = readJson(file, { runs: [] })
    st.webdavTest = {
      at: new Date().toISOString(),
      ok: Boolean(r.ok),
      code: r.code || '',
      status: r.status || 0,
      base: r.base || '',
      message: r.message || '',
      hint: r.hint || '',
    }
    writeJson(file, st)
  } catch { /* 记不上不影响本次结论 */ }
  log(`WebDAV 自检：${r.ok ? '成功' : '失败'}（${r.code || r.status}）${r.message || ''}`)
  return r
}

export async function apply(ctx) {
  const home = stateDirOf(ctx)
  const log = (m) => {
    try { appendLog(home, `[host] ${m}`) } catch { /* 忽略 */ }
    try { ctx.logger?.('dsh-archiver')?.info?.(m) } catch { /* 忽略 */ }
  }

  ensureDirs(home)
  const cfg0 = loadCfg(home)
  log(`已激活（home=${home}, dest=${cfg0.dest}, auto.onStart=${cfg0.auto.onStart}, everyHours=${cfg0.auto.everyHours}）`)

  // ── 工具：手动触发 / 看状态 / 改配置 ─────────────────────────
  const defineTool = await loadDefineTool(log)
  const registered = []
  const reg = (spec) => {
    try {
      const dispose = ctx.tools.register(defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters || {},
        output: textOutput,
        timeoutMs: spec.timeoutMs ?? 900000,
        async execute(args) {
          try {
            return lossless(await spec.execute(args || {}))
          } catch (e) {
            log(`工具 ${spec.name} 失败：${e?.message || e}`)
            return { ok: false, code: e?.code || 'FAILED', message: String(e?.message || e).slice(0, 500) }
          }
        },
      }))
      registered.push(spec.name)
      return dispose
    } catch (e) {
      log(`注册工具 ${spec.name} 失败：${e?.message || e}`)
      return null
    }
  }

  reg({
    name: 'dsh_archive_now',
    description: '立刻把 DSH 里的技能与插件各自打成 zip（手动归档入口）。省略参数时按设置页「手动模式」的默认值走。',
    parameters: {
      targets: { type: 'string', enum: ['all', 'skills', 'plugins'], description: '归档对象；省略 = 用配置里的 manual.defaultTargets' },
      dest: { type: 'string', enum: ['config', 'local', 'webdav', 'both'], description: '落地位置，config = 跟随配置' },
      dryRun: { type: 'boolean', description: 'true = 只扫描打包、不写盘不上传；省略 = 用 manual.dryRun' },
      projectCwd: { type: 'string', description: '可选：临时把这个项目根纳入技能扫描（找 .dsh/skills 与 .agents/skills）' },
    },
    async execute(args) {
      let cfg = loadCfg(home)
      const projectCwd = String(args.projectCwd || '').trim()
      if (projectCwd) cfg = { ...cfg, sources: { ...cfg.sources, projectCwd } }
      const targets = args.targets || cfg.manual.defaultTargets || 'all'
      const dryRun = args.dryRun === undefined ? Boolean(cfg.manual.dryRun) : Boolean(args.dryRun)
      const report = await runArchive({
        home,
        cfg,
        targets,
        dest: args.dest || 'config',
        dryRun,
        why: 'tool',
        log,
      })
      if (!dryRun && cfg.manual.openAfterRun) {
        try { openInShell(resolveSaveRoot(cfg, home)) } catch { /* 打不开就算了 */ }
      }
      return { ...report, saveRoot: report.saveRoot || resolveSaveRoot(cfg, home) }
    },
  })

  reg({
    name: 'dsh_archive_status',
    description: '看归档器状态：配置摘要、下次自动运行时间、能发现多少技能/插件、本地产物清单、最近几次运行记录与日志尾巴。',
    parameters: {
      details: { type: 'boolean', description: 'true = 带完整的技能/插件清单（默认只给数量）' },
      limit: { type: 'number', description: '产物清单最多几条，默认 50' },
    },
    async execute(args) {
      const cfg = loadCfg(home)
      const s = statusReport({ home, cfg })
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, args.limit)) : 50
      if (!args.details) {
        return {
          ok: true,
          running: s.running,
          configFile: s.configFile,
          saveRoot: s.saveRoot,
          dest: s.dest,
          auto: s.auto,
          manual: s.manual,
          nextRunAt: s.nextRunAt,
          webdav: s.webdav,
          counts: s.counts,
          lastRun: s.lastRun,
          runs: s.runs.slice(0, 5),
          artifacts: s.artifacts.slice(0, limit),
          notes: s.notes,
          logTail: s.logTail,
        }
      }
      return { ...s, artifacts: s.artifacts.slice(0, limit) }
    },
  })

  reg({
    name: 'dsh_archive_config',
    description: '读写归档器配置（$DSH_HOME/dsh-archiver/config.json）。action=schema 看所有字段；action=set 用点路径改一个值（如 auto.everyHours / manual.defaultTargets / webdav.url）。',
    parameters: {
      action: { type: 'string', enum: ['get', 'set', 'schema', 'test-webdav'], description: '默认 get' },
      key: { type: 'string', description: '点路径（action=set 时必填），如 webdav.url' },
      value: { type: 'string', description: '新值（按默认值类型自动转 bool/number/数组/JSON）' },
    },
    async execute(args) {
      const action = args.action || 'get'
      let cfg = loadCfg(home)
      if (action === 'schema') return { ok: true, ...panelSchema() }
      if (action === 'test-webdav') {
        const r = await runWebdavTest(home, log)
        return { ok: r.ok, ...r }
      }
      if (action === 'set') {
        const key = String(args.key || '').trim()
        if (!key) return { ok: false, code: 'NO_KEY', message: 'action=set 需要 key' }
        const r = applyConfigPatch(home, { [key]: args.value }, log)
        if (!r.applied.length) {
          return { ok: false, code: 'UNKNOWN_KEY', message: `未知配置项：${key}`, keys: fieldKeys() }
        }
        // 敏感值不回显（否则密码会进模型上下文）
        const sensitive = /(^|\.)password$/u.test(key)
        return {
          ok: true,
          key,
          value: sensitive ? '（已写入，不回显）' : getPath(r.config, key),
          configFile: configFile(home),
        }
      }
      // 读配置也脱敏：密码不回给模型
      return { ok: true, configFile: configFile(home), config: redactConfig(cfg) }
    },
  })

  reg({
    name: 'dsh_archive_import',
    description: '把本插件导出的备份导入回来：action=scan 只看会放到哪（预览），action=import 真正解压。来源可以是导出根目录、历史快照目录或单个 zip。技能直接进技能根；插件解压到「插件导入目录」并给出 link 命令。',
    parameters: {
      action: { type: 'string', enum: ['scan', 'import'], description: '默认 scan' },
      path: { type: 'string', description: '来源：目录（<保存目录> / history/<runId>）或单个 .zip 的绝对路径' },
      names: { type: 'string', description: '只导入这些名字（逗号分隔）；省略 = 全部' },
      overwrite: { type: 'boolean', description: 'true = 覆盖已存在的同名技能/插件（旧目录会改名成 .bak-<时间戳> 保留）' },
    },
    async execute(args) {
      const action = args.action || 'scan'
      const cfg = loadCfg(home)
      const source = { path: args.path || '' }
      const scan = scanImportSource({ source, home, cfg, dshHome: process.env.DSH_HOME })
      if (!scan.ok) return { ok: false, code: 'BAD_SOURCE', message: scan.error, notes: scan.notes }
      if (action === 'scan') return { ok: true, ...scan }

      const wanted = String(args.names || '').split(',').map((s) => s.trim()).filter(Boolean)
      const picked = wanted.length ? scan.items.filter((i) => wanted.includes(i.name)) : scan.items
      if (!picked.length) return { ok: false, code: 'NOTHING_SELECTED', message: '没有匹配的包', items: scan.items }
      const result = runImport({
        home,
        cfg,
        dshHome: process.env.DSH_HOME,
        items: picked,
        overwrite: Boolean(args.overwrite),
        log,
      })
      return { ok: result.ok, ...result }
    },
  })

  log(`工具已注册：${registered.join(', ') || '(一个都没成)'}`)

  // ── HTTP 桥（设置页的唯一后端） ──────────────────────────────
  mountHttp(ctx, home, log)

  // ── 自动触发 ────────────────────────────────────────────────
  const timers = []

  const fire = (why) => {
    let cfg
    try { cfg = loadCfg(home) } catch (e) { log(`读配置失败：${e?.message || e}`); return }
    if (!cfg.enabled) return
    if (isRunning()) { log(`已有归档在跑，跳过 ${why}`); return }
    runArchive({ home, cfg, why, log })
      .then((r) => {
        if (!r.ok && r.code === 'BUSY') return
        log(`自动归档（${why}）完成：ok=${r.ok} 打包=${r?.counts?.packaged ?? 0} 复用=${r?.counts?.reused ?? 0}`)
      })
      .catch((e) => log(`自动归档（${why}）异常：${e?.message || e}`))
  }

  if (cfg0.enabled && cfg0.auto.onStart) {
    const t = setTimeout(() => fire('startup'), Math.max(0, cfg0.auto.onStartDelayMs))
    t.unref?.()
    timers.push(t)
    log(`启动自动归档已排期：${cfg0.auto.onStartDelayMs}ms 后`)
  }

  const tick = setInterval(() => {
    try {
      const cfg = loadCfg(home)
      if (!cfg.enabled) return
      const st = readJson(join(home, 'state.json'), { runs: [] })
      const why = autoReason({ cfg, state: st, now: Date.now() })
      if (!why) return
      fire(why)
    } catch (e) {
      // ⚠️ 定时器里冒异常会杀掉整个宿主 —— 必须自己吞掉
      log(`定时器异常：${e?.message || e}`)
    }
  }, TICK_MS)
  tick.unref?.()
  timers.push(tick)

  ctx.effect(() => () => {
    for (const t of timers) {
      // Node 里 clearTimeout / clearInterval 互认，清两遍都安全
      try { clearTimeout(t) } catch { /* ignore */ }
      try { clearInterval(t) } catch { /* ignore */ }
    }
    log('已卸载：定时器已停')
  }, 'dsh-archiver: timers')
}

/** 挂一个 HTTP 桥（前缀 /api/dsh-archiver），设置页与外部脚本都用它 */
function mountHttp(ctx, home, log) {
  let mounted = false
  const handler = makeHttpHandler({ home, log })

  const attach = (fetchHost, how) => {
    if (mounted || !fetchHost?.register) return false
    mounted = true
    try {
      const dispose = fetchHost.register({
        path: '/api/dsh-archiver',
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: handler,
      })
      try {
        ctx.effect?.(() => () => { try { dispose?.() } catch { /* ignore */ } }, 'dsh-archiver: http')
      } catch { /* effect 不可用时让它随插件一起消失 */ }
      log(`HTTP 桥已挂载 /api/dsh-archiver（${how}）`)
      return true
    } catch (e) {
      mounted = false
      log(`HTTP 桥注册失败（${how}）：${e?.message || e}`)
      return false
    }
  }

  // ① 已经就绪就直接挂
  try { if (attach(ctx.get?.('connection')?.fetch, 'ctx.get')) return } catch { /* 继续 */ }

  // ② 还没就绪：等 connection 服务出现再挂（apply 阶段它经常是后起的）
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['connection'], (c) => {
        try { attach(c?.connection?.fetch, 'ctx.inject') } catch (e) { log(`HTTP 桥注入回调失败：${e?.message || e}`) }
      })
      log('HTTP 桥：等待 connection 服务就绪')
    } else {
      log('connection.fetch 不可用且 ctx.inject 不存在，HTTP 桥跳过（工具与 CLI 不受影响）')
    }
  } catch (e) {
    log(`HTTP 桥注入失败：${e?.message || e}`)
  }
}

function makeHttpHandler({ home, log }) {
  return async (request) => {
    const json = (status, body) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
    try {
      const url = new URL(request.url)
      const view = url.searchParams.get('view') || 'status'

      if (request.method === 'GET') {
        const cfg = loadCfg(home)
        if (view === 'boot') {
          // 设置页一次拿齐：字段描述 + 当前配置（**密码已脱敏**）+ 状态
          return json(200, {
            ok: true,
            schema: panelSchema(),
            config: redactConfig(cfg),
            status: statusReport({ home, cfg }),
          })
        }
        if (view === 'logs') {
          const n = Number(url.searchParams.get('lines') || 60)
          return json(200, { ok: true, lines: tailLog(home, Math.max(1, Math.min(500, n))), logFile: logFile(home) })
        }
        const s = statusReport({ home, cfg })
        const limit = Number(url.searchParams.get('limit') || 200)
        return json(200, { ok: true, ...s, artifacts: s.artifacts.slice(0, Math.max(1, Math.min(500, limit))) })
      }

      let body = {}
      try { body = await request.json() } catch { body = {} }
      const action = body?.action || 'status'

      if (action === 'run') {
        const cfg = loadCfg(home)
        const dryRun = body.dryRun === undefined ? Boolean(cfg.manual.dryRun) : Boolean(body.dryRun)
        const r = await runArchive({
          home,
          cfg,
          targets: body.targets || cfg.manual.defaultTargets || 'all',
          dest: body.dest || 'config',
          dryRun,
          why: body.why || 'panel',
          log,
        })
        if (!dryRun && cfg.manual.openAfterRun) {
          try { openInShell(resolveSaveRoot(cfg, home)) } catch { /* ignore */ }
        }
        return json(200, r)
      }

      if (action === 'config') {
        if (body.patch && typeof body.patch === 'object') {
          const r = applyConfigPatch(home, body.patch, log)
          return json(200, {
            ok: r.rejected.length === 0,
            config: redactConfig(r.config),
            applied: r.applied,
            rejected: r.rejected,
            status: statusReport({ home, cfg: r.config }),
          })
        }
        if (typeof body.key === 'string' && body.key) {
          const r = applyConfigPatch(home, { [body.key]: body.value }, log)
          const sensitive = /(^|\.)password$/u.test(body.key)
          return json(200, {
            ok: r.applied.length > 0,
            key: body.key,
            value: sensitive ? '（已写入，不回显）' : getPath(r.config, body.key),
            rejected: r.rejected,
            status: statusReport({ home, cfg: r.config }),
          })
        }
        const cfg = loadCfg(home)
        return json(200, { ok: true, config: redactConfig(cfg), configFile: configFile(home), schema: panelSchema() })
      }

      if (action === 'test-webdav') {
        const r = await runWebdavTest(home, log)
        return json(200, r)
      }

      if (action === 'open') {
        const cfg = loadCfg(home)
        const what = body.what || 'saveRoot'
        const map = {
          saveRoot: resolveSaveRoot(cfg, home),
          history: cfg.local.layout === 'run' ? resolveSaveRoot(cfg, home) : join(resolveSaveRoot(cfg, home), 'history'),
          importPlugins: importRoots(cfg, home, process.env.DSH_HOME).plugins,
          importSkills: importRoots(cfg, home, process.env.DSH_HOME).skills,
          log: logFile(home),
          home,
          config: configFile(home),
        }
        const target = map[what]
        if (!target) return json(400, { ok: false, code: 'UNKNOWN_TARGET', message: `未知目标：${what}` })
        openInShell(target)
        return json(200, { ok: true, opened: target })
      }

      if (action === 'import-scan') {
        const cfg = loadCfg(home)
        const r = scanImportSource({ source: body.source || {}, home, cfg, dshHome: process.env.DSH_HOME })
        return json(200, r)
      }

      if (action === 'import') {
        const cfg = loadCfg(home)
        const items = Array.isArray(body.items) ? body.items : []
        if (!items.length) return json(400, { ok: false, code: 'NOTHING_SELECTED', message: '没有勾选任何包' })
        const r = runImport({
          home,
          cfg,
          dshHome: process.env.DSH_HOME,
          items,
          overwrite: Boolean(body.overwrite),
          log,
        })
        return json(200, { ...r, status: statusReport({ home, cfg }) })
      }

      if (action === 'prune') {
        const cfg = loadCfg(home)
        const keep = Math.max(0, Number(body.keep ?? cfg.local.keepVersions) || 0)
        const root = cfg.local.layout === 'run' ? resolveSaveRoot(cfg, home) : join(resolveSaveRoot(cfg, home), 'history')
        const r = pruneRuns(root, keep, log)
        return json(200, { ok: true, root, removed: r.removed, kept: r.kept, skipped: r.skipped })
      }

      if (action === 'status') {
        const s = statusReport({ home, cfg: loadCfg(home) })
        return json(200, { ok: true, ...s })
      }

      return json(400, { ok: false, code: 'UNKNOWN_ACTION', message: `未知 action：${action}` })
    } catch (e) {
      log(`HTTP 桥异常：${e?.message || e}`)
      return json(500, { ok: false, message: String(e?.message || e).slice(0, 400) })
    }
  }
}
