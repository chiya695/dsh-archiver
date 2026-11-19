#!/usr/bin/env node
/**
 * bin/dsh-archiver.mjs —— 命令行入口（不依赖宿主进程，随时可跑）
 * ============================================================================
 * 用法：
 *   node bin/dsh-archiver.mjs run                 # 按配置归档一次
 *   node bin/dsh-archiver.mjs run --dest both     # 本地 + WebDAV
 *   node bin/dsh-archiver.mjs run --targets skills --dry-run
 *   node bin/dsh-archiver.mjs status              # 状态总览
 *   node bin/dsh-archiver.mjs list                # 本地产物
 *   node bin/dsh-archiver.mjs config              # 打印配置
 *   node bin/dsh-archiver.mjs config set auto.everyHours 6
 *   node bin/dsh-archiver.mjs test-webdav
 *
 * 环境变量：DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR 会被自动识别。
 * ============================================================================
 */
import { join } from 'node:path'
import { loadCfg, saveCfg, setPath, getPath, coerceValue, configFile } from '../lib/config.mjs'
import { stateDirOf, ensureDirs, dshHomePath, profileDirPath } from '../lib/state.mjs'
import { runArchive, statusReport, listArtifacts, testWebdav } from '../lib/run.mjs'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--details') out.details = true
    else if (a === '--json') out.json = true
    else if (a.startsWith('--')) {
      const [k, ...rest] = a.slice(2).split('=')
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (rest.length) out[key] = rest.join('=')
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i]
      else out[key] = true
    } else out._.push(a)
  }
  return out
}

function fmtBytes(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`
  return `${(v / 1073741824).toFixed(2)} GB`
}

function printReport(r) {
  const line = (s) => console.log(s)
  line(`run ${r.runId}  ${r.at}  why=${r.why}  targets=${r.targets}  dest=${r.dest}${r.dryRun ? '  (dry-run)' : ''}`)
  line(`  打包 ${r.counts.packaged} 个（技能 ${r.counts.skills} / 插件 ${r.counts.plugins}）`
    + `  源 ${fmtBytes(r.totals.sourceBytes)} → zip ${fmtBytes(r.totals.zipBytes)}`)
  if (r.saveRoot) line(`  本地：${r.saveRoot}（写入 ${r.local.written} 个，${fmtBytes(r.local.bytes)}）`)
  if (r.remote?.enabled) line(`  远端：${r.remote.base || '(未就绪)'}（上传 ${r.remote.uploaded} 个，失败 ${r.remote.failed.length}）`)
  if (r.skills.length) {
    line('  技能：')
    for (const s of r.skills) line(`    - ${s.name}${s.origin ? `  [${s.origin}]` : ''}  ${s.zipBytes ? fmtBytes(s.zipBytes) : ''}`)
  }
  if (r.plugins.length) {
    line('  插件：')
    for (const p of r.plugins) line(`    - ${p.name}${p.version ? `@${p.version}` : ''}  [${p.origin}]  ${fmtBytes(p.zipBytes)}`)
  }
  if (r.skipped?.length) {
    line('  跳过：')
    for (const s of r.skipped.slice(0, 20)) line(`    - ${s.kind}:${s.name} —— ${s.reason}`)
  }
  if (r.errors?.length) {
    line('  失败：')
    for (const e of r.errors.slice(0, 20)) line(`    - ${e.kind}:${e.name} —— ${e.error}`)
  }
  if (r.remote?.failed?.length) {
    line('  上传失败：')
    for (const e of r.remote.failed.slice(0, 20)) line(`    - ${e.name} —— ${e.error}`)
  }
  line(`  结论：${r.ok ? '成功' : '有问题（见上）'}`)
}

async function main() {
  const argv = parseArgs(process.argv.slice(2))
  const cmd = argv._[0] || 'status'
  const home = (argv.home && String(argv.home)) || stateDirOf(null)
  ensureDirs(home)
  let cfg = loadCfg(home)

  if (cmd === 'run') {
    if (argv.out) cfg = { ...cfg, local: { ...cfg.local, root: String(argv.out) } }
    const r = await runArchive({
      home,
      cfg,
      targets: argv.targets || 'all',
      dest: argv.dest || 'config',
      dryRun: Boolean(argv.dryRun),
      why: argv.why || 'cli',
      log: (m) => process.stderr.write(`[dsh-archiver] ${m}\n`),
    })
    if (argv.json) console.log(JSON.stringify(r, null, 2))
    else printReport(r)
    process.exitCode = r.ok ? 0 : 1
    return
  }

  if (cmd === 'status') {
    const s = statusReport({ home, cfg })
    if (argv.json) { console.log(JSON.stringify(s, null, 2)); return }
    console.log(`家目录：${s.home}`)
    console.log(`配置文件：${s.configFile}`)
    console.log(`保存目录：${s.saveRoot}${s.saveRootExists ? '' : '（还不存在，首次归档会建）'}`)
    console.log(`落地位置：${s.dest}   WebDAV：${s.webdav.enabled ? `${s.webdav.url} (root=${s.webdav.root}, 密码${s.webdav.hasPassword ? '已配' : '未配'})` : '未启用'}`)
    console.log(`自动：启动时=${s.auto.onStart ? '开' : '关'}  每 ${s.auto.everyHours}h  每天 ${s.auto.dailyAt || '-'}`)
    console.log(`可归档：技能 ${s.counts.skills} 个，插件 ${s.counts.plugins} 个；已有产物 ${s.counts.artifacts} 个`)
    if (s.lastRun) console.log(`上次：${s.lastRun.at} ${s.lastRun.why} ok=${s.lastRun.ok} 打包 ${s.lastRun.counts?.packaged ?? '?'}`)
    if (s.notes.length) {
      console.log('备注：')
      for (const n of s.notes.slice(0, 15)) console.log(`  - ${n}`)
    }
    if (argv.details) {
      console.log('技能清单：')
      for (const k of s.skills) console.log(`  - ${k.name} [${k.origin}] ${k.description ? String(k.description).slice(0, 60) : ''}`)
      console.log('插件清单：')
      for (const p of s.plugins) console.log(`  - ${p.name}${p.version ? `@${p.version}` : ''} [${p.origin}]${p.active ? '' : ' (未启用)'}`)
    }
    return
  }

  if (cmd === 'list') {
    const items = listArtifacts(cfg.local.root ? String(cfg.local.root) : join(home, 'out'))
    if (argv.json) { console.log(JSON.stringify(items, null, 2)); return }
    if (!items.length) { console.log('还没有产物'); return }
    for (const it of items) console.log(`${it.kind.padEnd(7)} ${fmtBytes(it.bytes).padStart(10)}  ${it.mtime}  ${it.path}`)
    return
  }

  if (cmd === 'config') {
    const sub = argv._[1] || 'get'
    if (sub === 'set') {
      const key = argv._[2]
      const value = argv._[3]
      if (!key) { console.error('用法：config set <key> <value>'); process.exitCode = 2; return }
      setPath(cfg, key, coerceValue(key, value))
      saveCfg(home, cfg)
      cfg = loadCfg(home)
      console.log(`${key} = ${JSON.stringify(getPath(cfg, key))}  （已写入 ${configFile(home)}）`)
      return
    }
    console.log(JSON.stringify(cfg, null, 2))
    return
  }

  if (cmd === 'test-webdav') {
    const r = await testWebdav(cfg)
    console.log(JSON.stringify(r, null, 2))
    process.exitCode = r.ok ? 0 : 1
    return
  }

  if (cmd === 'paths') {
    console.log(JSON.stringify({ DSH_HOME: dshHomePath(), profileDir: profileDirPath(), home, configFile: configFile(home) }, null, 2))
    return
  }

  console.log(`未知子命令：${cmd}\n可用：run | status | list | config [set <key> <value>] | test-webdav | paths`)
  process.exitCode = 2
}

main().catch((e) => {
  console.error(`[dsh-archiver] 失败：${e?.stack || e}`)
  process.exitCode = 1
})
