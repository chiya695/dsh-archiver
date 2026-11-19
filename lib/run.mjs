/**
 * lib/run.mjs —— 跑一次归档
 * ============================================================================
 * 流程：发现 → 逐个打包 → 落地（本地 / WebDAV）→ 写 manifest → 记 state。
 *
 * 三条纪律：
 *  ① 全局单飞：上一次还没跑完，这一次直接返回 BUSY（定时器和手动撞车时不打架）；
 *  ② 单项失败不影响整体：每个技能/插件各自 try/catch，最后汇总 errors；
 *  ③ 产物永远原子写：先写 .tmp 再 rename —— 半截 zip 比没有 zip 更糟。
 * ============================================================================
 */
import { existsSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { loadCfg, resolveSaveRoot } from './config.mjs'
import { discoverAll } from './scan.mjs'
import { collectTree, sourceSignature } from './tree.mjs'
import { listSnapshots } from './importer.mjs'
import { buildZip } from './zip.mjs'
import { uploadBuffer, davBaseUrl, davPassword, testWebdav } from './webdav.mjs'
import { nextRunAt, localDateKey } from './schedule.mjs'
import {
  appendLog, ensureDirs, nowIso, readJson, runIdNow, writeBinary, writeJson, tailLog,
} from './state.mjs'

// 版本号以 package.json 为唯一真相（以前手写 '0.1.0'，升级后 manifest 里就一直是旧号）
export const TOOL_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

let running = null

export function isRunning() {
  return running !== null
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function shortError(e) {
  return String(e?.message || e || '未知错误').slice(0, 400)
}

/**
 * 归档一次。
 * @param {object} o
 * @param {string} o.home           插件家目录
 * @param {object} [o.cfg]          配置（省略则现读）
 * @param {'all'|'skills'|'plugins'} [o.targets]
 * @param {'config'|'local'|'webdav'|'both'} [o.dest]
 * @param {boolean} [o.dryRun]      只算不写
 * @param {string} [o.why]          触发原因（写进日志与 manifest）
 * @param {Function} [o.log]
 * @returns {Promise<object>} 汇总报告
 */
export async function runArchive(o) {
  if (running) {
    return { ok: false, code: 'BUSY', message: '上一次归档还在跑，本次跳过' }
  }
  running = (async () => {
    try {
      return await runArchiveInner(o)
    } finally {
      running = null
    }
  })()
  return running
}

async function runArchiveInner(o = {}) {
  const home = o.home
  const log = typeof o.log === 'function' ? o.log : () => {}
  const cfg = o.cfg || loadCfg(home)
  ensureDirs(home)

  const runId = runIdNow()
  const at = nowIso()
  const why = o.why || 'manual'
  const targets = o.targets || 'all'
  let dest = o.dest && o.dest !== 'config' ? o.dest : cfg.dest
  if (!['local', 'webdav', 'both'].includes(dest)) dest = cfg.dest

  /**
   * 目标不成立就明确拒绝，**不要**悄悄退回本地。
   * （2026-11-18：面板上点「立即归档」看不出落到哪儿，就是因为以前会静默降级。）
   */
  const wantsRemote = dest === 'webdav' || dest === 'both'
  const webdavMissing = !cfg.webdav.enabled ? '没启用' : (!cfg.webdav.url ? '缺地址' : '')
  if (wantsRemote && !o.dryRun && webdavMissing) {
    log(`拒绝归档：要求 ${dest}，但 WebDAV ${webdavMissing}`)
    return {
      ok: false,
      code: 'WEBDAV_NOT_CONFIGURED',
      dest,
      message: `这次要求传到 WebDAV，但 WebDAV ${webdavMissing}，所以没有执行（也没有偷偷只存本地）`,
      hint: '在下面「WebDAV」分组里勾上「启用 WebDAV 上传」、填地址 / 用户名 / 密码，再用「测试 WebDAV」确认能通；或者改用左边的「归档到本地」。',
    }
  }
  if (wantsRemote && !davPassword(cfg) && cfg.webdav.username) {
    // 有用户名没密码：多数服务会 401，提前说清楚，别让人对着假成功发愁
    log('WebDAV 配了用户名但没解析到密码（password 为空、passwordEnv 未设）')
  }

  const profileDir = o.profileDir || process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || home, 'profiles', process.env.DSH_PROFILE || 'desktop')
  const dshHome = o.dshHome || process.env.DSH_HOME || join(home, '..')

  const wantSkills = targets !== 'plugins' && cfg.targets.skills
  const wantPlugins = targets !== 'skills' && cfg.targets.plugins

  log(`开始归档（run=${runId}, why=${why}, targets=${targets}, dest=${dest}${o.dryRun ? ', dry-run' : ''}）`)

  const discovered = discoverAll({ dshHome, profileDir, cfg })
  const items = [
    ...(wantSkills ? discovered.skills : []),
    ...(wantPlugins ? discovered.plugins : []),
  ]

  const maxFileBytes = Math.max(1, cfg.zip.maxFileMB) * 1024 * 1024
  const layout = cfg.local.layout === 'run' ? 'run' : 'flat'
  const saveRoot = resolveSaveRoot(cfg, home)

  // 增量：只有 flat + 本地落地才谈得上"复用已有 zip"
  const canSkip = Boolean(cfg.zip.skipUnchanged) && layout === 'flat' && (dest === 'local' || dest === 'both')
  let prevByKey = new Map()
  if (canSkip) {
    const prev = readJson(join(saveRoot, 'manifest.json'), null)
    if (prev && Array.isArray(prev.items)) {
      prevByKey = new Map(prev.items.map((i) => [`${i.kind}:${i.zipBase || i.name}`, i]))
    }
  }

  const artifacts = []
  const skipped = []
  const errors = []
  const warnings = [...discovered.notes]
  let reusedCount = 0

  for (const item of items) {
    const t0 = Date.now()
    const kindDir = item.kind === 'skill' ? 'skills' : 'plugins'
    const zipName = `${item.zipBase}.zip`
    const relPath = layout === 'run' ? `${runId}/${kindDir}/${zipName}` : `${kindDir}/${zipName}`
    const label = item.name

    try {
      // ① 增量：源没变 + 上次的包还在，就直接复用
      if (canSkip) {
        let signature = ''
        try {
          if (item.file) {
            const st = statSync(item.file)
            signature = `1:${st.size}:${Math.round(st.mtimeMs)}`
          } else {
            signature = sourceSignature(item.dir, { exclude: cfg.zip.exclude })
          }
        } catch { signature = '' }

        const prev = prevByKey.get(`${item.kind}:${item.zipBase}`)
        const prevFile = prev ? join(saveRoot, ...String(prev.relPath || '').split('/')) : ''
        if (signature && prev && prev.sourceSignature === signature && prev.relPath === relPath && prevFile && existsSync(prevFile)) {
          const buf = readFileSync(prevFile)
          artifacts.push({
            kind: item.kind,
            name: item.name,
            zipBase: item.zipBase,
            origin: item.origin,
            version: item.version || '',
            description: item.description || '',
            active: item.active === undefined ? true : item.active,
            source: item.file || item.dir,
            relPath,
            zipName,
            files: prev.files || 0,
            bytes: prev.bytes || 0,
            zipBytes: buf.length,
            sha256: sha256(buf),
            skippedFiles: prev.skippedFiles || 0,
            skippedBytes: prev.skippedBytes || 0,
            warnings: (prev.warnings || []).slice(0, 20),
            durationMs: Date.now() - t0,
            sourceSignature: signature,
            reused: true,
            buffer: buf,
          })
          reusedCount++
          continue
        }
      }

      let entries = []
      let stats = { files: 0, bytes: 0, skippedFiles: 0, skippedBytes: 0 }
      let itemWarnings = []

      if (item.file) {
        const data = readFileSync(item.file)
        entries = [{ name: `${item.zipBase}/${basename(item.file)}`, data, mtime: statSync(item.file).mtime }]
        stats = { files: 1, bytes: data.length, skippedFiles: 0, skippedBytes: 0 }
      } else {
        const collected = collectTree(item.dir, {
          prefix: item.zipBase,
          exclude: cfg.zip.exclude,
          maxFileBytes,
        })
        entries = collected.entries
        stats = collected.stats
        itemWarnings = collected.warnings
      }

      if (!entries.length) {
        skipped.push({ kind: item.kind, name: label, origin: item.origin, reason: '没有可打包的文件' })
        continue
      }

      const zipBuffer = buildZip(entries, { level: cfg.zip.level })
      let signature = ''
      try { signature = item.file ? `1:${stats.bytes}:${Math.round(statSync(item.file).mtimeMs)}` : sourceSignature(item.dir, { exclude: cfg.zip.exclude }) } catch { signature = '' }

      artifacts.push({
        kind: item.kind,
        name: item.name,
        zipBase: item.zipBase,
        origin: item.origin,
        version: item.version || '',
        description: item.description || '',
        active: item.active === undefined ? true : item.active,
        source: item.file || item.dir,
        relPath,
        zipName,
        files: stats.files,
        bytes: stats.bytes,
        zipBytes: zipBuffer.length,
        sha256: sha256(zipBuffer),
        skippedFiles: stats.skippedFiles,
        skippedBytes: stats.skippedBytes,
        warnings: itemWarnings.slice(0, 20),
        durationMs: Date.now() - t0,
        sourceSignature: signature,
        reused: false,
        buffer: zipBuffer,
      })
    } catch (e) {
      errors.push({ kind: item.kind, name: label, error: shortError(e) })
      log(`打包失败 ${item.kind}:${label} —— ${shortError(e)}`)
    }
  }

  // ── 落地：本地 ───────────────────────────────────────────────
  const local = { root: saveRoot, written: 0, reused: 0, bytes: 0, errors: [] }
  if (dest === 'local' || dest === 'both') {
    if (!o.dryRun) {
      for (const a of artifacts) {
        try {
          if (a.reused) { local.reused++; continue }
          const file = join(saveRoot, ...a.relPath.split('/'))
          writeBinary(file, a.buffer)
          local.written++
          local.bytes += a.zipBytes
        } catch (e) {
          local.errors.push({ name: a.name, error: shortError(e) })
        }
      }
    }
  }
  // 本地写失败必须算进整次的结果里：以前只放 local.errors，
  // 于是"12 个包里 3 个写不进去"仍然报成功。
  for (const e of local.errors) {
    errors.push({ kind: 'local', name: e.name, error: e.error })
    log(`本地写入失败 ${e.name} —— ${e.error}`)
  }

  // ── 落地：WebDAV ────────────────────────────────────────────
  const remote = { enabled: dest === 'webdav' || dest === 'both', base: '', uploaded: 0, bytes: 0, failed: [] }
  if (remote.enabled && !o.dryRun) {
    try {
      remote.base = davBaseUrl(cfg)
    } catch (e) {
      errors.push({ kind: 'webdav', name: 'config', error: shortError(e) })
    }
    if (remote.base) {
      for (const a of artifacts) {
        try {
          const r = await uploadBuffer(cfg, a.relPath, a.buffer, 'application/zip')
          if (r.ok) {
            remote.uploaded++
            remote.bytes += a.zipBytes
          } else {
            remote.failed.push({ name: a.name, error: r.error || `HTTP ${r.status}` })
          }
        } catch (e) {
          remote.failed.push({ name: a.name, error: shortError(e) })
        }
      }
    }
  }

  // ── manifest ────────────────────────────────────────────────
  const manifest = {
    tool: 'dsh-archiver',
    version: TOOL_VERSION,
    runId,
    at,
    why,
    targets,
    dest,
    layout,
    dryRun: Boolean(o.dryRun),
    host: process.env.COMPUTERNAME || '',
    dshHome,
    profile: process.env.DSH_PROFILE || '',
    profileDir,
    saveRoot: dest === 'local' || dest === 'both' ? saveRoot : '',
    remoteBase: remote.base || '',
    counts: {
      skills: discovered.skills.length,
      plugins: discovered.plugins.length,
      packaged: artifacts.length,
      packagedSkills: artifacts.filter((a) => a.kind === 'skill').length,
      packagedPlugins: artifacts.filter((a) => a.kind === 'plugin').length,
      reused: artifacts.filter((a) => a.reused).length,
      skipped: skipped.length,
      failed: errors.length,
    },
    totals: {
      bytes: artifacts.reduce((n, a) => n + a.bytes, 0),
      zipBytes: artifacts.reduce((n, a) => n + a.zipBytes, 0),
    },
    items: artifacts.map(({ buffer, ...rest }) => rest),
    skipped,
    errors,
    warnings: [...new Set(warnings)].slice(0, 200),
  }

  if (!o.dryRun) {
    try {
      if (dest === 'local' || dest === 'both') {
        writeJson(join(saveRoot, 'manifest.json'), manifest)
        if (layout === 'run') writeJson(join(saveRoot, runId, 'manifest.json'), manifest)
      }
      if (remote.enabled && remote.base) {
        const payload = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        await uploadBuffer(cfg, 'manifest.json', payload, 'application/json; charset=utf-8')
      }
    } catch (e) {
      errors.push({ kind: 'manifest', name: 'manifest.json', error: shortError(e) })
    }
  }

  // ── 历史版本 ────────────────────────────────────────────────
  const keepVersions = Math.max(0, Number(cfg.local.keepVersions) || 0)
  const snapRoot = layout === 'run' ? saveRoot : join(saveRoot, 'history')
  const history = {
    enabled: Boolean(keepVersions > 0 && !o.dryRun && (dest === 'local' || dest === 'both')),
    keep: keepVersions,
    root: snapRoot,
    dir: join(snapRoot, runId),
    written: 0,
    kept: 0,
    pruned: [],
  }
  if (history.enabled) {
    try {
      if (layout === 'run') {
        // run 布局下 <runId>/ 本身就是快照，manifest 已经写进去了
        history.written = artifacts.length
      } else {
        for (const a of artifacts) {
          writeBinary(join(history.dir, ...a.relPath.split('/')), a.buffer)
          history.written++
        }
        writeJson(join(history.dir, 'manifest.json'), manifest)
      }
      const pruned = pruneRuns(snapRoot, keepVersions, log)
      history.pruned = pruned.removed || []
      history.kept = pruned.kept ?? 0
      log(`历史版本：写入 ${runId}（${history.written} 个包），现存 ${history.kept} 份${history.pruned.length ? `，清理 ${history.pruned.length} 份旧快照` : ''}`)
    } catch (e) {
      errors.push({ kind: 'history', name: runId, error: shortError(e) })
      log(`写历史版本失败：${shortError(e)}`)
    }
  }

  const report = {
    ok: errors.length === 0 && remote.failed.length === 0,
    runId,
    at,
    why,
    targets,
    dest,
    dryRun: Boolean(o.dryRun),
    saveRoot: manifest.saveRoot,
    remoteBase: remote.base,
    counts: manifest.counts,
    totals: {
      sourceBytes: manifest.totals.bytes,
      zipBytes: manifest.totals.zipBytes,
      durationMs: artifacts.reduce((n, a) => n + (a.durationMs || 0), 0),
    },
    local: { written: local.written, reused: local.reused, bytes: local.bytes, errors: local.errors },
    history,
    remote: { enabled: remote.enabled, uploaded: remote.uploaded, bytes: remote.bytes, failed: remote.failed },
    skills: artifacts.filter((a) => a.kind === 'skill').map(brief),
    plugins: artifacts.filter((a) => a.kind === 'plugin').map(brief),
    skipped,
    errors,
    warnings: manifest.warnings.slice(0, 20),
  }

  // ── state ───────────────────────────────────────────────────
  if (!o.dryRun) {
    try {
      const stateFile = join(home, 'state.json')
      const st = readJson(stateFile, { runs: [] })
      const prev = Array.isArray(st.runs) ? st.runs : []
      const record = {
        runId,
        at,
        why,
        targets,
        dest,
        ok: report.ok,
        counts: report.counts,
        zipBytes: manifest.totals.zipBytes,
        skipped: skipped.length,
        failed: errors.length + remote.failed.length,
      }
      st.runs = [record, ...prev].slice(0, 50)
      st.lastRunAt = at
      st.lastOk = report.ok
      st.lastRunId = runId
      // ⚠️ 必须用**本地日期**，跟 autoReason / nextRunAt 的判定口径一致。
      //    以前用 toISOString()（UTC），在 UTC+8 的深夜（00:00–07:59）会记成前一天，
      //    于是每过一次 minGapMinutes 就又"今天还没跑"地重复归档。
      if (cfg.auto.dailyAt) st.lastDailySlot = `${localDateKey(new Date())} ${cfg.auto.dailyAt}`
      writeJson(stateFile, st)
    } catch (e) {
      log(`写 state.json 失败：${shortError(e)}`)
    }
  }

  log(`归档结束 run=${runId}：打包 ${artifacts.length} 个（技能 ${report.skills.length} / 插件 ${report.plugins.length}），`
    + `本地写 ${local.written}，远端传 ${remote.uploaded}，跳过 ${skipped.length}，失败 ${errors.length + remote.failed.length}`)
  return report
}

function brief(a) {
  // ⚠️ 工具输出必须是「无损 JSON」：undefined 会被校验层判成非法值，
  //    所以字段要么有值要么不出现，绝不写 `x: undefined`。
  const out = {
    name: a.name,
    origin: a.origin,
    zip: a.relPath,
    files: a.files,
    bytes: a.bytes,
    zipBytes: a.zipBytes,
    sha256: a.sha256.slice(0, 16),
  }
  if (a.version) out.version = a.version
  if (a.active === false) out.active = false
  if (a.reused) out.reused = true
  return out
}

/**
 * 只保留最近 n 个**本插件写的**快照目录，返回删了哪些、还剩几份。
 *
 * ⚠️ 光看目录名像 `20261119-123456` 是不够的：保存目录是用户自己的地方，
 *    里面完全可能有别人（或用户自己）放的同名目录。删之前必须确认
 *    `<dir>/manifest.json` 的 `tool` 是 `dsh-archiver`；不认识的目录一律跳过、不删。
 */
export function pruneRuns(root, keep, log = () => {}) {
  let all = []
  try {
    all = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{8}-\d{6}$/u.test(d.name))
      .map((d) => d.name)
  } catch { return { removed: [], kept: 0, skipped: [] } }

  const ours = []
  const skipped = []
  for (const name of all) {
    const manifest = readJson(join(root, name, 'manifest.json'), null)
    if (manifest && manifest.tool === 'dsh-archiver') ours.push(name)
    else skipped.push(name)
  }
  ours.sort()
  if (skipped.length) {
    log(`跳过 ${skipped.length} 个不是本插件写的目录（不删）：${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ' …' : ''}`)
  }

  const removed = []
  for (const name of ours.slice(0, Math.max(0, ours.length - keep))) {
    const target = join(root, name)
    try {
      rmSync(target, { recursive: true, force: true })
      removed.push(name)
      log(`清理旧运行目录：${name}`)
    } catch (e) {
      log(`清理 ${name} 失败：${shortError(e)}`)
    }
  }
  return { removed, kept: Math.min(ours.length, Math.max(0, keep)), skipped }
}

/** 列出本地产物（flat 布局） */
export function listArtifacts(root) {
  const out = []
  for (const kindDir of ['skills', 'plugins']) {
    const dir = join(root, kindDir)
    if (!existsSync(dir)) continue
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !/\.zip$/iu.test(ent.name)) continue
      const full = join(dir, ent.name)
      try {
        const st = statSync(full)
        out.push({ kind: kindDir === 'skills' ? 'skill' : 'plugin', name: ent.name, path: full, bytes: st.size, mtime: st.mtime.toISOString() })
      } catch { /* ignore */ }
    }
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)))
  return out
}

/** 状态总览（面板 / 工具 / CLI 共用） */
export function statusReport({ home, cfg, profileDir }) {
  const c = cfg || loadCfg(home)
  const saveRoot = resolveSaveRoot(c, home)
  const state = readJson(join(home, 'state.json'), { runs: [] })
  const artifacts = existsSync(saveRoot) ? listArtifacts(saveRoot) : []
  let manifest = null
  try { manifest = JSON.parse(readFileSync(join(saveRoot, 'manifest.json'), 'utf8')) } catch { manifest = null }

  let discovered = { skills: [], plugins: [], notes: [] }
  try {
    discovered = discoverAll({
      dshHome: process.env.DSH_HOME || join(home, '..'),
      profileDir: profileDir || process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || home, 'profiles', process.env.DSH_PROFILE || 'desktop'),
      cfg: c,
    })
  } catch (e) {
    discovered.notes.push(`发现失败：${shortError(e)}`)
  }

  return {
    ok: true,
    version: TOOL_VERSION,
    home,
    configFile: join(home, 'config.json'),
    logFile: join(home, 'log', 'archiver.log'),
    running: isRunning(),
    saveRoot,
    saveRootExists: existsSync(saveRoot),
    webdav: {
      enabled: c.webdav.enabled,
      url: c.webdav.url,
      root: c.webdav.root,
      user: c.webdav.username,
      hasPassword: Boolean(davPassword(c)),
      passwordFromEnv: Boolean(c.webdav.passwordEnv && process.env[c.webdav.passwordEnv]),
      passwordEnv: c.webdav.passwordEnv,
    },
    auto: c.auto,
    manual: c.manual,
    nextRunAt: nextRunAt({ cfg: c, state }),
    webdavTest: state.webdavTest || null,
    targets: c.targets,
    dest: c.dest,
    skipUnchanged: c.zip.skipUnchanged,
    history: {
      keep: Math.max(0, Number(c.local.keepVersions) || 0),
      layout: c.local.layout,
      root: c.local.layout === 'run' ? saveRoot : join(saveRoot, 'history'),
      snapshots: listSnapshots(c.local.layout === 'run' ? saveRoot : join(saveRoot, 'history')),
      warning: (() => {
        if (!(Number(c.local.keepVersions) > 0)) {
          return c.local.layout === 'run'
            ? '当前是 run 布局且「历史版本数量」= 0：每跑一次多一个目录，且不会自动清理。建议设成 5–10。'
            : ''
        }
        // 历史快照是写在本地保存目录里的；只传 WebDAV 时本地根本不落盘，快照也就无从谈起
        if (c.dest === 'webdav') {
          return '当前落地位置是「只传 WebDAV」：本地不写文件，所以不会留历史版本。要留就把「默认落地位置」改成「只存本地」或「本地 + WebDAV」。'
        }
        return ''
      })(),
    },
    counts: {
      skills: discovered.skills.length,
      plugins: discovered.plugins.length,
      artifacts: artifacts.length,
    },
    lastRun: (state.runs || [])[0] || null,
    runs: (state.runs || []).slice(0, 10),
    artifacts: artifacts.slice(0, 200),
    manifestAt: manifest?.at || null,
    manifestCounts: manifest?.counts || null,
    skills: discovered.skills.map((s) => ({ name: s.name, origin: s.origin, description: s.description })),
    plugins: discovered.plugins.map((p) => ({ name: p.name, version: p.version, origin: p.origin, active: p.active })),
    notes: discovered.notes.slice(0, 40),
    logTail: tailLog(home, 15),
  }
}

export { testWebdav }
