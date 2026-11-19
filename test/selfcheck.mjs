#!/usr/bin/env node
/**
 * test/selfcheck.mjs —— 不碰宿主的自检
 * ============================================================================
 * 覆盖四件事（都是"改了会静悄悄坏"的地方）：
 *  ① zip 写入器能不能被自己读回来（CRC / 长度 / 名字 / 目录结构）；
 *  ② collectTree 的排除、超大文件跳过、链接环保护；
 *  ③ 配置规范化（乱填的值被锤回合法范围）；
 *  ④ 真实机器上的发现 + 一次 dry-run 归档（不写盘），以及 apply() 在假 ctx 上不抛错。
 *
 * 用法：node test/selfcheck.mjs
 * ============================================================================
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildZip, readZip, crc32 } from '../lib/zip.mjs'
import { collectTree, dirSize, MAX_ENTRIES } from '../lib/tree.mjs'
import { normalizeCfg, DEFAULTS, setPath, coerceValue, getPath, applyPatch, redactConfig } from '../lib/config.mjs'
import { autoReason, nextRunAt, localDateKey } from '../lib/schedule.mjs'
import { fieldKeys, panelSchema } from '../lib/schema.mjs'
import { discoverAll } from '../lib/scan.mjs'
import { runArchive, statusReport, pruneRuns, TOOL_VERSION } from '../lib/run.mjs'
import { scanImportSource, runImport } from '../lib/importer.mjs'
import { loadCfg } from '../lib/config.mjs'
import { configFile } from '../lib/config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
let pass = 0
let fail = 0

function check(name, fn) {
  try {
    const r = fn()
    if (r === false) throw new Error('断言为 false')
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}\n      ${e?.message || e}`)
  }
}

async function checkAsync(name, fn) {
  try {
    const r = await fn()
    if (r === false) throw new Error('断言为 false')
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}\n      ${e?.message || e}`)
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-archiver-selfcheck-'))

console.log('1) zip 写入 / 读回')
check('CRC32 常量正确（"123456789" => 0xCBF43926）', () => crc32(Buffer.from('123456789')) === 0xcbf43926)
check('空目录也能产出合法空 zip', () => readZip(buildZip([])).length === 0)
check('文本 + 二进制 + 中文名都能读回', () => {
  const entries = [
    { name: 'demo/SKILL.md', data: Buffer.from('# 技能\n内容 test\n') },
    { name: 'demo/bin/blob.dat', data: Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)) },
    { name: '中文目录/说明.txt', data: Buffer.from('中文内容 UTF-8', 'utf8') },
  ]
  const zip = buildZip(entries, { level: 9 })
  const back = readZip(zip)
  if (back.length !== 3) throw new Error(`条目数 ${back.length}`)
  const md = back.find((e) => e.name === 'demo/SKILL.md')
  if (!md || md.data.toString('utf8') !== '# 技能\n内容 test\n') throw new Error('内容不一致')
  const cn = back.find((e) => e.name === '中文目录/说明.txt')
  if (!cn || cn.data.toString('utf8') !== '中文内容 UTF-8') throw new Error('中文路径/内容不一致')
  if (zip.length < 100) throw new Error('zip 太小')
  return true
})
check('level 0（只存储）也能读回', () => {
  const back = readZip(buildZip([{ name: 'a.txt', data: Buffer.from('x'.repeat(200)) }], { level: 0 }))
  return back[0].data.length === 200
})

console.log('2) 目录遍历（排除 / 超大文件 / 链接环）')
check('node_modules 被排除、大文件被跳过', () => {
  const dir = join(tmp, 'tree1')
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'a'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'x', 'big.js'), 'nope')
  writeFileSync(join(dir, 'skills', 'a', 'SKILL.md'), '# a')
  writeFileSync(join(dir, 'huge.bin'), Buffer.alloc(2048))
  const out = collectTree(dir, { prefix: 'p', exclude: ['node_modules'], maxFileBytes: 1024 })
  const names = out.entries.map((e) => e.name)
  if (names.some((n) => n.includes('node_modules'))) throw new Error('node_modules 没被排除')
  if (names.some((n) => n.includes('huge.bin'))) throw new Error('大文件没被跳过')
  if (!names.includes('p/skills/a/SKILL.md')) throw new Error(`条目不对：${names.join(',')}`)
  if (out.stats.skippedFiles < 1) throw new Error('跳过统计不对')
  return true
})
check('dirSize 只数不读，排除生效', () => {
  const s = dirSize(join(tmp, 'tree1'), { exclude: ['node_modules', 'huge.bin'] })
  return s.files === 1
})
check('排除规则按「名字全等」：.git 被挡，.github/.gitlab 要留下', () => {
  const dir = join(tmp, 'excl-exact')
  mkdirSync(join(dir, '.git', 'objects'), { recursive: true })
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  mkdirSync(join(dir, '.gitlab'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'x')
  writeFileSync(join(dir, '.gitlab', 'ci.yml'), 'x')
  writeFileSync(join(dir, '.git', 'config'), 'x')
  writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'x')
  writeFileSync(join(dir, 'SKILL.md'), '# a')
  const out = collectTree(dir, { prefix: 'demo', exclude: DEFAULTS.zip.exclude })
  const names = out.entries.map((e) => e.name)
  if (names.some((n) => n.includes('/.git/'))) throw new Error('.git 没被排除')
  if (names.some((n) => n.includes('node_modules'))) throw new Error('node_modules 没被排除')
  if (!names.includes('demo/.github/workflows/ci.yml')) throw new Error(`.github 被误排除：${names.join(',')}`)
  if (!names.includes('demo/.gitlab/ci.yml')) throw new Error('.gitlab 被误排除')
  return true
})
check('条目上限：buildZip 超 65535 给人话报错，collectTree 封顶 65000', () => {
  let msg = ''
  try {
    buildZip(Array.from({ length: 65536 }, (_, i) => ({ name: `f/${i}`, data: Buffer.from('x') })))
  } catch (e) { msg = String(e?.message || e) }
  if (!/文件太多/.test(msg)) throw new Error(`没有给出人话报错：${msg || '(没报错)'}`)
  if (MAX_ENTRIES > 65535) throw new Error('MAX_ENTRIES 没和 zip 上限对齐')
  return true
})

console.log('3) 配置规范化')
check('乱填的值被锤回合法范围', () => {
  const cfg = normalizeCfg({
    enabled: 'yes',
    dest: 'nonsense',
    local: { layout: 'weird', keepRuns: -3 },
    webdav: { enabled: true, url: '', root: 42 },
    auto: { everyHours: -1, dailyAt: '99:99', minGapMinutes: 'abc' },
    zip: { level: 99, maxFileMB: 0, exclude: ['', '  ', 'node_modules'] },
  })
  if (cfg.local.layout !== 'flat') throw new Error('layout 没锤回 flat')
  // 负数被钳到 0（0 = 只留最新，属于安全的一侧）
  if (cfg.local.keepVersions !== 0) throw new Error(`keepVersions=${cfg.local.keepVersions}`)
  if (cfg.zip.level !== 9) throw new Error(`level=${cfg.zip.level}`)
  if (cfg.zip.maxFileMB !== 1) throw new Error(`maxFileMB=${cfg.zip.maxFileMB}`)
  if (cfg.auto.dailyAt !== '') throw new Error(`dailyAt=${cfg.auto.dailyAt}`)
  if (cfg.auto.everyHours !== 0) throw new Error(`everyHours=${cfg.auto.everyHours}`)
  if (cfg.dest !== 'local') throw new Error('webdav 没配地址却没降级')
  if (cfg.zip.exclude.join(',') !== 'node_modules') throw new Error('exclude 没清理空串')
  return true
})
check('老配置的 keepRuns 只在 run 布局下才搬过来（flat 不偷偷开历史）', () => {
  const runCfg = normalizeCfg({ local: { layout: 'run', keepRuns: 7 } })
  if (runCfg.local.keepVersions !== 7) throw new Error(`run 布局没迁移：${runCfg.local.keepVersions}`)
  if ('keepRuns' in runCfg.local) throw new Error('旧键没清掉')
  const flatCfg = normalizeCfg({ local: { layout: 'flat', keepRuns: 5 } })
  if (flatCfg.local.keepVersions !== 0) throw new Error(`flat 不该迁移：${flatCfg.local.keepVersions}`)
  const fresh = normalizeCfg({ local: { keepVersions: 3, keepRuns: 9 } })
  if (fresh.local.keepVersions !== 3) throw new Error('新键应优先')
  return true
})
check('点路径写 + 类型转换', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS))
  setPath(cfg, 'webdav.url', coerceValue('webdav.url', 'https://dav.example.com/dav/'))
  setPath(cfg, 'auto.everyHours', coerceValue('auto.everyHours', '6'))
  setPath(cfg, 'auto.onStart', coerceValue('auto.onStart', 'false'))
  setPath(cfg, 'zip.exclude', coerceValue('zip.exclude', 'node_modules\ndist'))
  if (getPath(cfg, 'webdav.url') !== 'https://dav.example.com/dav/') throw new Error('url 不对')
  if (getPath(cfg, 'auto.everyHours') !== 6) throw new Error('everyHours 不是数字')
  if (getPath(cfg, 'auto.onStart') !== false) throw new Error('onStart 不是 false')
  if (getPath(cfg, 'zip.exclude').length !== 2) throw new Error('exclude 没解析成数组')
  return true
})

check('loadCfg 会把规范化写回文件（只写一次就收敛）', () => {
  const home = join(tmp, 'home-persist')
  mkdirSync(home, { recursive: true })
  // 模拟旧版本留下的配置：有 keepRuns，没有 manual/keepVersions 等新键
  writeFileSync(configFile(home), JSON.stringify({ local: { layout: 'flat', keepRuns: 5 } }, null, 2))
  loadCfg(home)
  const after1 = readFileSync(configFile(home), 'utf8')
  const parsed = JSON.parse(after1)
  if ('keepRuns' in parsed.local) throw new Error('旧键没被清掉')
  if (!('keepVersions' in parsed.local)) throw new Error('新键没写进文件')
  if (!('manual' in parsed)) throw new Error('manual 没写进文件')
  // 再读一次不应该再动文件
  loadCfg(home)
  const after2 = readFileSync(configFile(home), 'utf8')
  if (after1 !== after2) throw new Error('每次读取都在重写文件')
  return true
})

check('redactConfig 抹掉密码但保留"是否已配置"', () => {
  const cfg = normalizeCfg({ webdav: { enabled: true, url: 'https://x/dav/', username: 'u', password: 'secret-pw' } })
  const out = redactConfig(cfg)
  if (out.webdav.password !== '') throw new Error('密码没被抹掉')
  if (out.webdav.hasPassword !== true) throw new Error('hasPassword 没标出来')
  if (out.webdav.username !== 'u') throw new Error('其它字段不该被改')
  if (cfg.webdav.password !== 'secret-pw') throw new Error('原始 cfg 不该被改动')
  const envOnly = redactConfig(normalizeCfg({ webdav: { enabled: true, url: 'https://x/dav/', password: '', passwordEnv: 'AUDIT_PW' } }))
  if (envOnly.webdav.hasPassword !== false) throw new Error('没有密码时 hasPassword 应为 false')
  return true
})

console.log('4) 设置项（schema / 补丁 / 下次运行时间）')
check('schema 每个键都在 DEFAULTS 里有默认值（否则类型转换会瞎猜）', () => {
  const missing = fieldKeys().filter((k) => getPath(DEFAULTS, k) === undefined)
  if (missing.length) throw new Error(`缺默认值：${missing.join(', ')}`)
  const s = panelSchema()
  if (!s.groups.length) throw new Error('分组为空')
  for (const g of s.groups) {
    if (!g.id || !g.title) throw new Error(`分组缺 id/title：${JSON.stringify(g).slice(0, 80)}`)
    for (const f of g.fields) {
      if (!f.key || !f.label) throw new Error(`字段缺 key/label：${JSON.stringify(f).slice(0, 80)}`)
      if (!['bool', 'number', 'text', 'password', 'textarea', 'select'].includes(f.type)) {
        throw new Error(`未知控件类型 ${f.type}（${f.key}）`)
      }
      if (f.type === 'select' && !Array.isArray(f.options)) throw new Error(`${f.key} 是 select 但没 options`)
    }
  }
  return true
})
check('面板补丁：认识的键按默认值类型转换', () => {
  const home = join(tmp, 'patchhome1')
  mkdirSync(home, { recursive: true })
  const r = applyPatch(home, {
    'auto.everyHours': '6',
    'auto.onStart': 'false',
    'manual.defaultTargets': 'plugins',
    'zip.skipUnchanged': 'true',
    'zip.exclude': 'node_modules,dist',
  })
  if (r.rejected.length) throw new Error(`被拒：${r.rejected.join(',')}`)
  if (r.config.auto.everyHours !== 6) throw new Error('everyHours 没转成数字')
  if (r.config.auto.onStart !== false) throw new Error('onStart 没转成 false')
  if (r.config.manual.defaultTargets !== 'plugins') throw new Error('defaultTargets 没写进去')
  if (r.config.zip.skipUnchanged !== true) throw new Error('skipUnchanged 没转成 true')
  if (r.config.zip.exclude.length !== 2) throw new Error('exclude 没拆成数组')
  const again = loadCfg(home)
  if (again.auto.everyHours !== 6) throw new Error('落盘后读回来不一致')
  return true
})
check('面板补丁：陌生键被拒，不污染 config.json', () => {
  const home = join(tmp, 'patchhome2')
  mkdirSync(home, { recursive: true })
  const r = applyPatch(home, { 'evil.key': 'x', 'auto.everyHours': '-5' })
  if (r.rejected.join(',') !== 'evil.key') throw new Error(`rejected=${r.rejected}`)
  if (getPath(r.config, 'evil.key') !== undefined) throw new Error('陌生键被写进去了')
  if (r.config.auto.everyHours !== 0) throw new Error('负数没被钳到 0')
  return true
})
check('下次运行时间：按 everyHours / dailyAt 算', () => {
  const now = new Date(2026, 10, 17, 10, 0, 0, 0).getTime()
  const cfg = { ...DEFAULTS, enabled: true, auto: { ...DEFAULTS.auto, everyHours: 6, dailyAt: '', minGapMinutes: 0 } }
  const a = nextRunAt({ cfg, state: { lastRunAt: new Date(now - 3_600_000).toISOString() }, now })
  if (a !== new Date(now + 5 * 3_600_000).toISOString()) throw new Error(`everyHours 算错：${a}`)
  const cfg2 = { ...cfg, auto: { ...cfg.auto, everyHours: 0, dailyAt: '11:30' } }
  const b = nextRunAt({ cfg: cfg2, state: {}, now })
  if (b !== new Date(2026, 10, 17, 11, 30, 0, 0).toISOString()) throw new Error(`dailyAt 算错：${b}`)
  const c = nextRunAt({ cfg: cfg2, state: { lastDailySlot: '2026-11-17 11:30' }, now })
  if (c !== new Date(2026, 10, 18, 11, 30, 0, 0).toISOString()) throw new Error(`跨天算错：${c}`)
  if (nextRunAt({ cfg: { ...cfg, enabled: false, auto: { ...cfg.auto, everyHours: 1 } }, state: {}, now }) !== '') {
    throw new Error('关掉总开关还算出下次时间')
  }
  return true
})

console.log('5) 调度判定（纯函数）')
check('everyHours：从没跑过就该跑', () => {
  const cfg = { ...DEFAULTS, enabled: true, auto: { ...DEFAULTS.auto, onStart: false, everyHours: 6, dailyAt: '', minGapMinutes: 30 } }
  return autoReason({ cfg, state: {} }) === 'every:6h'
})
check('everyHours：刚跑过不跑', () => {
  const cfg = { ...DEFAULTS, enabled: true, auto: { ...DEFAULTS.auto, everyHours: 6, dailyAt: '', minGapMinutes: 30 } }
  const now = Date.now()
  return autoReason({ cfg, state: { lastRunAt: new Date(now - 3_600_000).toISOString() }, now }) === ''
})
check('everyHours：隔了 7 小时要跑', () => {
  const cfg = { ...DEFAULTS, enabled: true, auto: { ...DEFAULTS.auto, everyHours: 6, dailyAt: '', minGapMinutes: 30 } }
  const now = Date.now()
  return autoReason({ cfg, state: { lastRunAt: new Date(now - 7 * 3_600_000).toISOString() }, now }) === 'every:6h'
})
check('dailyAt：到点前不跑、到点后跑一次、同一天不重复', () => {
  const cfg = { ...DEFAULTS, enabled: true, auto: { ...DEFAULTS.auto, everyHours: 0, dailyAt: '03:00', minGapMinutes: 0 } }
  const at = (h, m) => new Date(2026, 10, 17, h, m, 0, 0).getTime()
  const before = autoReason({ cfg, state: {}, now: at(2, 59) })
  const after = autoReason({ cfg, state: {}, now: at(3, 5) })
  const again = autoReason({ cfg, state: { lastDailySlot: '2026-11-17 03:00' }, now: at(9, 0) })
  if (before !== '') throw new Error(`到点前竟然要跑：${before}`)
  if (after !== 'daily:03:00') throw new Error(`到点后没跑：${after}`)
  if (again !== '') throw new Error(`同一天重复跑：${again}`)
  return true
})
check('minGapMinutes 能压住"刚手动跑完又来定时"', () => {
  const cfg = { ...DEFAULTS, enabled: true, auto: { ...DEFAULTS.auto, everyHours: 1, dailyAt: '', minGapMinutes: 30 } }
  const now = Date.now()
  return autoReason({ cfg, state: { lastRunAt: new Date(now - 60_000).toISOString() }, now }) === ''
})
check('总开关关掉就永不自动跑', () => {
  const cfg = { ...DEFAULTS, enabled: false, auto: { ...DEFAULTS.auto, everyHours: 1 } }
  return autoReason({ cfg, state: {} }) === ''
})

console.log('6) 真实发现 + 真跑归档')
const realHome = join(tmp, 'home')
mkdirSync(realHome, { recursive: true })
const realCfg = { ...loadCfg(realHome), local: { ...DEFAULTS.local, root: join(tmp, 'out') } }

let discovered = null
check('能发现到技能与插件', () => {
  discovered = discoverAll({
    dshHome: process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'),
    profileDir: process.env.DSH_PROFILE_DIR || '',
    cfg: realCfg,
  })
  console.log(`      技能 ${discovered.skills.length} 个，插件 ${discovered.plugins.length} 个`)
  if (!discovered.skills.length) throw new Error('一个技能都没发现')
  if (!discovered.plugins.length) throw new Error('一个插件都没发现')
  return true
})

await checkAsync('dry-run 归档不写盘', async () => {
  const r = await runArchive({ home: realHome, cfg: realCfg, why: 'selfcheck', dryRun: true })
  if (!r.ok) throw new Error(`dry-run 失败：${JSON.stringify(r.errors || r)}`)
  if (r.counts.packaged < 1) throw new Error('一个都没打包')
  if (existsSync(join(tmp, 'out', 'manifest.json'))) throw new Error('dry-run 竟然写了 manifest')
  console.log(`      打包 ${r.counts.packaged} 个，zip 合计 ${(r.totals.zipBytes / 1048576).toFixed(1)}MB`)
  return true
})

await checkAsync('真跑一次：产物可读回、manifest 结构正确', async () => {
  const r = await runArchive({ home: realHome, cfg: realCfg, why: 'selfcheck-write' })
  if (!r.ok) throw new Error(`归档失败：${JSON.stringify(r.errors || r)}`)
  const out = join(tmp, 'out')
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
  if (manifest.tool !== 'dsh-archiver') throw new Error('manifest.tool 不对')
  if (!Array.isArray(manifest.items) || manifest.items.length !== r.counts.packaged) throw new Error('manifest.items 数量不对')
  for (const item of manifest.items.slice(0, 8)) {
    const file = join(out, ...item.relPath.split('/'))
    if (!existsSync(file)) throw new Error(`产物缺失：${item.relPath}`)
    const back = readZip(readFileSync(file))
    if (!back.length) throw new Error(`空 zip：${item.relPath}`)
  }
  // 每件产物都有 sha256
  if (manifest.items.some((i) => !/^[0-9a-f]{64}$/.test(i.sha256))) throw new Error('sha256 缺失')
  return true
})

await checkAsync('增量归档：源没变就复用，不重写 zip', async () => {
  const out = join(tmp, 'incremental')
  const home = join(tmp, 'home-inc')
  mkdirSync(home, { recursive: true })
  const cfg = { ...loadCfg(home), local: { ...DEFAULTS.local, root: out, layout: 'flat' }, zip: { ...DEFAULTS.zip, skipUnchanged: true } }
  const first = await runArchive({ home, cfg, why: 'inc-1' })
  if (!first.ok) throw new Error(`第一次失败：${JSON.stringify(first.errors)}`)
  if (first.counts.reused) throw new Error(`第一次不该有复用：${first.counts.reused}`)
  const target = first.skills[0]
  const file = join(out, ...target.zip.split('/'))
  const before = statSync(file).mtimeMs
  await new Promise((r) => setTimeout(r, 30))
  const second = await runArchive({ home, cfg, why: 'inc-2' })
  if (!second.ok) throw new Error(`第二次失败：${JSON.stringify(second.errors)}`)
  const reused = second.counts.reused
  if (!reused) throw new Error('第二次一个都没复用')
  if (second.local.written !== 0) throw new Error(`第二次还写了 ${second.local.written} 个文件`)
  if (statSync(file).mtimeMs !== before) throw new Error('复用的 zip 被重写了')
  console.log(`      第一次打包 ${first.counts.packaged} 个，第二次复用 ${reused} 个`)
  return true
})

await checkAsync('要求云端但没配 WebDAV：明确拒绝，不偷偷存本地', async () => {
  const out = join(tmp, 'refuse')
  const home = join(tmp, 'home-refuse')
  mkdirSync(home, { recursive: true })
  const cfg = {
    ...loadCfg(home),
    local: { ...DEFAULTS.local, root: out },
    webdav: { ...DEFAULTS.webdav, enabled: false, url: '' },
  }
  const r = await runArchive({ home, cfg, dest: 'webdav', why: 'refuse' })
  if (r.ok !== false || r.code !== 'WEBDAV_NOT_CONFIGURED') throw new Error(`返回不对：${JSON.stringify(r).slice(0, 200)}`)
  if (existsSync(join(out, 'manifest.json'))) throw new Error('被拒绝时竟然写了本地产物（说明偷偷降级了）')
  if (!/WebDAV/.test(r.hint || '')) throw new Error('hint 没有指向 WebDAV 分组')
  // 空跑不受影响：它本来就不写盘
  const dry = await runArchive({ home, cfg, dest: 'webdav', dryRun: true, why: 'refuse-dry' })
  if (dry.ok !== true) throw new Error(`空跑也不该被拒：${dry.code}`)
  return true
})

await checkAsync('本地写不进去必须算失败（不能报成功）', async () => {
  const out = join(tmp, 'local-fail')
  const home = join(tmp, 'home-localfail')
  mkdirSync(home, { recursive: true })
  mkdirSync(out, { recursive: true })
  // 把 <保存目录>/skills 做成一个同名**文件**，让 mkdir(skills) 必失败
  writeFileSync(join(out, 'skills'), 'i am a file')
  const cfg = { ...loadCfg(home), local: { ...DEFAULTS.local, root: out, layout: 'flat', keepVersions: 0 } }
  const r = await runArchive({ home, cfg, targets: 'skills', why: 'audit-local-fail' })
  if (r.local.errors.length === 0) throw new Error('没触发本地写失败，测试无效')
  if (r.ok !== false) throw new Error(`本地一个都没写进去，ok 仍然是 ${r.ok}`)
  if (!r.errors.some((e) => e.kind === 'local')) throw new Error('local 错误没进 report.errors')
  if (r.counts.failed !== r.errors.length) throw new Error('counts.failed 和 errors 不一致')
  const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  if (st.lastOk !== false) throw new Error('state.lastOk 仍记成功')
  if (!(st.runs[0].failed > 0)) throw new Error('state.runs[0].failed 没算本地失败')
  return true
})

await checkAsync('dailyAt 的 slot 用本地日期（深夜不会再跑一次）', async () => {
  const home = join(tmp, 'home-slot')
  mkdirSync(home, { recursive: true })
  const out = join(tmp, 'slot-out')
  const cfg = {
    ...loadCfg(home),
    local: { ...DEFAULTS.local, root: out, layout: 'flat', keepVersions: 0 },
    auto: { ...DEFAULTS.auto, onStart: false, everyHours: 0, dailyAt: '03:30', minGapMinutes: 30 },
  }
  const r = await runArchive({ home, cfg, targets: 'skills', why: 'slot-audit' })
  if (!r.ok) throw new Error('归档失败')
  const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  if (!st.lastDailySlot) throw new Error('没记 slot')
  const localDay = localDateKey(new Date())
  if (!st.lastDailySlot.startsWith(localDay)) {
    throw new Error(`slot 用了非本地日期：${st.lastDailySlot}（本地今天 ${localDay}）`)
  }
  // 刚跑完，紧接着的判定不应再触发
  const why = autoReason({ cfg, state: st, now: Date.now() })
  if (why) throw new Error(`刚跑完又判定要跑：${why}`)
  return true
})

await checkAsync('报告是"无损 JSON"（宿主的工具输出校验会拒绝 undefined）', async () => {
  const r = await runArchive({ home: realHome, cfg: realCfg, why: 'selfcheck-lossless', dryRun: true })
  // 递归找 undefined / NaN / Infinity / function —— 宿主报的是
  // tool returned invalid output: value is not lossless JSON
  const bad = []
  const walk = (v, path) => {
    if (v === undefined) { bad.push(`${path}=undefined`); return }
    if (typeof v === 'number' && !Number.isFinite(v)) { bad.push(`${path}=${v}`); return }
    if (typeof v === 'function') { bad.push(`${path}=function`); return }
    if (v === null || typeof v !== 'object') return
    if (v instanceof Date) { bad.push(`${path}=Date`); return }
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
  }
  walk(r, 'report')
  if (bad.length) throw new Error(`非无损字段：${bad.slice(0, 5).join(', ')}`)
  const clone = JSON.parse(JSON.stringify(r))
  if (JSON.stringify(clone) !== JSON.stringify(r)) throw new Error('JSON 往返后不相等')
  if (clone.counts.packaged !== r.counts.packaged) throw new Error('往返后数据变了')
  return true
})

await checkAsync('历史版本：只保留最近 N 份，最新那份仍可读', async () => {
  const out = join(tmp, 'history')
  const home = join(tmp, 'home-history')
  mkdirSync(home, { recursive: true })
  const cfg = {
    ...loadCfg(home),
    local: { ...DEFAULTS.local, root: out, layout: 'flat', keepVersions: 2 },
  }
  const runs = []
  for (let i = 0; i < 3; i++) {
    const r = await runArchive({ home, cfg, why: `hist-${i}` })
    runs.push(r)
    if (!r.history?.enabled) throw new Error('历史版本没启用')
    if (r.history.written !== r.counts.packaged) throw new Error(`快照写入数不对：${r.history.written}`)
    await new Promise((res) => setTimeout(res, 1100))
  }
  const snaps = readdirSync(join(out, 'history'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}-\d{6}$/.test(d.name)).map((d) => d.name)
  if (snaps.length !== 2) throw new Error(`应有 2 份快照，实际 ${snaps.length}：${snaps.join(',')}`)
  const newest = snaps.sort().at(-1)
  const snapManifest = JSON.parse(readFileSync(join(out, 'history', newest, 'manifest.json'), 'utf8'))
  if (!snapManifest.items?.length) throw new Error('快照里的 manifest 没有条目')
  const oneZip = join(out, 'history', newest, ...snapManifest.items[0].relPath.split('/'))
  if (!existsSync(oneZip)) throw new Error(`快照里缺文件：${oneZip}`)
  if (!readZip(readFileSync(oneZip)).length) throw new Error('快照里的 zip 打不开')
  // 最新那份仍然在 flat 的固定路径上
  if (!existsSync(join(out, 'skills')) || !existsSync(join(out, 'manifest.json'))) throw new Error('flat 最新产物没了')
  console.log(`      3 次归档 → 只保留 ${snaps.length} 份快照（${snaps.join(', ')}）`)
  return true
})

await checkAsync('导入：把自己导出的东西再导入回来（技能 + 插件 + 覆盖备份）', async () => {
  const src = join(tmp, 'exp')
  const home = join(tmp, 'home-import')
  mkdirSync(home, { recursive: true })
  const cfg = { ...loadCfg(home), local: { ...DEFAULTS.local, root: src, layout: 'flat', keepVersions: 0 } }
  const exp = await runArchive({ home, cfg, why: 'export-for-import' })
  if (!exp.ok) throw new Error(`导出失败：${JSON.stringify(exp.errors)}`)

  const skillsRoot = join(tmp, 'import-skills')
  const pluginsRoot = join(tmp, 'import-plugins')
  const impCfg = {
    ...cfg,
    sources: { ...DEFAULTS.sources, skillImportRoot: skillsRoot },
    local: { ...cfg.local, pluginImportDir: pluginsRoot },
  }
  const scan = scanImportSource({ source: { path: src }, home, cfg: impCfg })
  if (!scan.ok) throw new Error(`扫描失败：${scan.error}`)
  if (!scan.items.length) throw new Error('一个包都没扫到')
  if (scan.items.some((i) => i.exists)) throw new Error('全新目录不该有"已存在"')
  console.log(`      扫到 ${scan.items.length} 个包（技能 ${scan.items.filter((i) => i.kind === 'skill').length} / 插件 ${scan.items.filter((i) => i.kind === 'plugin').length}）`)

  const res = runImport({ home, cfg: impCfg, items: scan.items })
  if (res.failed.length) throw new Error(`导入失败：${JSON.stringify(res.failed).slice(0, 200)}`)
  if (res.imported.length !== scan.items.length) throw new Error('导入数量对不上')
  for (const x of res.imported) {
    const marker = x.kind === 'skill' ? 'SKILL.md' : 'package.json'
    if (!existsSync(join(x.target, marker))) throw new Error(`${x.name} 里没有 ${marker}（${x.target}）`)
  }
  if (!res.pluginCommands.length) throw new Error('导入插件后没给出 link 命令')

  // 再导一次：不覆盖 → 全跳过
  const again = runImport({ home, cfg: impCfg, items: scan.items })
  if (again.imported.length !== 0 || again.skipped.length !== scan.items.length) throw new Error('第二次应该全部跳过')
  // 覆盖 → 有导入，且旧目录变成 .bak-
  const forced = runImport({ home, cfg: impCfg, items: scan.items.slice(0, 2), overwrite: true })
  if (!forced.imported.length) throw new Error('强制覆盖没导入')
  const hasBak = forced.imported.some((x) => x.backup && existsSync(x.backup))
  if (!hasBak) throw new Error('覆盖时没留下 .bak 备份')
  return true
})

await checkAsync('导入：zip 里带 ../ 的条目会被整体拒绝', async () => {
  const badZip = join(tmp, 'evil.zip')
  writeFileSync(badZip, buildZip([
    { name: 'evil/SKILL.md', data: Buffer.from('---\nname: evil\n---\n') },
    { name: 'evil/../../pwned.txt', data: Buffer.from('x') },
  ]))
  const home = join(tmp, 'home-evil')
  mkdirSync(home, { recursive: true })
  const cfg = { ...loadCfg(home), sources: { ...DEFAULTS.sources, skillImportRoot: join(tmp, 'evil-skills') } }
  const scan = scanImportSource({ source: { path: badZip }, home, cfg })
  if (!scan.ok || !scan.items.length) throw new Error('单个 zip 来源应该能扫到 1 个包')
  const res = runImport({ home, cfg, items: scan.items })
  if (res.failed.length !== 1) throw new Error('穿越包应该失败')
  if (!/可疑路径/.test(res.failed[0].error)) throw new Error(`错误信息不对：${res.failed[0].error}`)
  if (existsSync(join(tmp, 'pwned.txt'))) throw new Error('居然写到上级目录了')
  return true
})

await checkAsync('保留名（NUL/CON）既不打进包，也不会被导入回来', async () => {
  const dir = join(tmp, 'reserved')
  mkdirSync(join(dir, 'skill-a'), { recursive: true })
  writeFileSync(join(dir, 'skill-a', 'SKILL.md'), '# a')
  writeFileSync(join(dir, 'skill-a', 'ok.txt'), 'fine')
  // Windows 上能创建、但删不掉的设备名（这也是 dsh-archiver 自己踩过的坑）
  writeFileSync('\\\\?\\' + join(dir, 'skill-a', 'NUL'), 'junk')
  const out = collectTree(join(dir, 'skill-a'), { prefix: 'skill-a' })
  const names = out.entries.map((e) => e.name.toLowerCase())
  if (names.some((n) => n.endsWith('/nul'))) throw new Error(`NUL 被打进包了：${names.join(',')}`)
  if (!names.includes('skill-a/ok.txt')) throw new Error('正常文件不该被过滤')
  // 导入时也要拦：手写一个含 NUL 的 zip
  const zipPath = join(tmp, 'with-nul.zip')
  writeFileSync(zipPath, buildZip([
    { name: 'weird/SKILL.md', data: Buffer.from('---\nname: weird\n---\n') },
    { name: 'weird/NUL', data: Buffer.from('junk') },
  ]))
  const home = join(tmp, 'home-nul')
  mkdirSync(home, { recursive: true })
  const cfg = { ...loadCfg(home), sources: { ...DEFAULTS.sources, skillImportRoot: join(tmp, 'nul-skills') } }
  const scan = scanImportSource({ source: { path: zipPath }, home, cfg })
  const res = runImport({ home, cfg, items: scan.items })
  if (res.failed.length) throw new Error(`导入失败：${JSON.stringify(res.failed)}`)
  if (!res.imported[0] || res.imported[0].skippedReserved !== 1) throw new Error('保留名没被跳过')
  if (existsSync(join(tmp, 'nul-skills', 'weird', 'NUL'))) throw new Error('NUL 又被写回来了')
  return true
})

await checkAsync('导入：包名里的 ../ 不能把文件写到导入目录之外', async () => {
  const home = join(tmp, 'home-evil-name')
  mkdirSync(home, { recursive: true })
  const zipPath = join(tmp, 'evil-name.zip')
  writeFileSync(zipPath, buildZip([
    { name: 'pkg/package.json', data: Buffer.from(JSON.stringify({ name: '../../pwned-pkg', version: '9.9.9' })) },
    { name: 'pkg/index.js', data: Buffer.from('// hi') },
  ]))
  const pluginsRoot = join(tmp, 'safe-plugins')
  const cfg = { ...loadCfg(home), local: { ...DEFAULTS.local, pluginImportDir: pluginsRoot } }
  const scan = scanImportSource({ source: { path: zipPath }, home, cfg })
  if (!scan.items.length) throw new Error('没扫到包')
  const outside = join(tmp, '..', 'pwned-pkg')
  const res = runImport({ home, cfg, items: scan.items })
  if (res.failed.length) throw new Error(`不该失败：${JSON.stringify(res.failed)}`)
  const got = res.imported[0]
  if (existsSync(outside) || existsSync(join(tmp, 'pwned-pkg'))) throw new Error('写到导入目录之外了')
  if (!got.target.startsWith(pluginsRoot)) throw new Error(`目标不在导入根内：${got.target}`)
  if (!existsSync(join(pluginsRoot, 'pwned-pkg', 'package.json'))) throw new Error('没落到净化后的名字上')
  return true
})

await checkAsync('单文件技能（裸 .md）能导出也能导回', async () => {
  const flatRoot = join(tmp, 'flatmd-root')
  mkdirSync(flatRoot, { recursive: true })
  writeFileSync(join(flatRoot, 'my-flat-skill.md'), '---\nname: my-flat-skill\ndescription: 单文件技能\n---\n用法\n')
  const home = join(tmp, 'home-flatmd')
  mkdirSync(home, { recursive: true })
  const out = join(tmp, 'flatmd-out')
  const cfg = {
    ...loadCfg(home),
    local: { ...DEFAULTS.local, root: out, layout: 'flat', keepVersions: 0 },
    sources: { ...DEFAULTS.sources, extraSkillRoots: [flatRoot], includeBundledSkills: false, includeAgentsSkills: false },
  }
  const exp = await runArchive({ home, cfg, targets: 'skills', why: 'flatmd' })
  if (!exp.ok) throw new Error('导出失败')
  const zip = join(out, 'skills', 'my-flat-skill.zip')
  if (!existsSync(zip)) throw new Error('没生成 my-flat-skill.zip')

  const skillsRoot = join(tmp, 'flatmd-import')
  const impCfg = { ...cfg, sources: { ...cfg.sources, skillImportRoot: skillsRoot } }
  const scan = scanImportSource({ source: { path: zip }, home, cfg: impCfg })
  if (!scan.items.length) throw new Error(`扫描不到单文件技能：${JSON.stringify(scan.notes)}`)
  if (!scan.items[0].flatMd) throw new Error('没标记成单文件技能')
  if (!scan.items[0].target.endsWith('my-flat-skill.md')) throw new Error(`目标不像单文件：${scan.items[0].target}`)
  const res = runImport({ home, cfg: impCfg, items: scan.items })
  if (res.failed.length) throw new Error(`导入失败：${JSON.stringify(res.failed)}`)
  if (!existsSync(join(skillsRoot, 'my-flat-skill.md'))) throw new Error('没落成 .md 文件')
  // 覆盖一次：应留 .bak
  const again = runImport({ home, cfg: impCfg, items: scan.items, overwrite: true })
  if (!again.imported[0]?.backup) throw new Error('覆盖时没留 .bak 备份')
  return true
})

await checkAsync('来源填「run 布局的保存目录」也能扫到包（自动下钻一层时间戳目录）', async () => {
  const home = join(tmp, 'home-runroot')
  mkdirSync(home, { recursive: true })
  const outRun = join(tmp, 'runroot-out')
  const cfg = { ...loadCfg(home), local: { ...DEFAULTS.local, root: outRun, layout: 'run', keepVersions: 5 } }
  const r = await runArchive({ home, cfg, targets: 'skills', why: 'runroot' })
  if (!r.ok) throw new Error('run 布局归档失败')
  const scan = scanImportSource({ source: { path: outRun }, home, cfg })
  if (!scan.items.length) throw new Error(`扫不到：${JSON.stringify(scan.notes)}`)
  if (scan.items.some((i) => !existsSync(i.archive))) throw new Error('扫到了不存在的 zip')
  console.log(`      run 布局根目录扫到 ${scan.items.length} 个包`)
  return true
})

await checkAsync('pruneRuns 只删本插件写的快照，别人同名目录不碰', async () => {
  const root = join(tmp, 'prune-root')
  mkdirSync(join(root, '20260101-000001'), { recursive: true })
  writeFileSync(join(root, '20260101-000001', 'manifest.json'), JSON.stringify({ tool: 'dsh-archiver', items: [] }))
  mkdirSync(join(root, '20260101-000002'), { recursive: true })
  writeFileSync(join(root, '20260101-000002', 'manifest.json'), JSON.stringify({ tool: 'dsh-archiver', items: [] }))
  // 用户自己放的同名目录（别的工具 / 自己的资料）
  mkdirSync(join(root, '20260101-000003', 'photos'), { recursive: true })
  writeFileSync(join(root, '20260101-000003', 'photos', 'a.txt'), 'my own data')
  writeFileSync(join(root, '20260101-000003', 'manifest.json'), JSON.stringify({ tool: 'something-else' }))

  const r = pruneRuns(root, 1, () => {})
  if (r.removed.includes('20260101-000003')) throw new Error('把不属于本插件的目录删了！')
  if (!existsSync(join(root, '20260101-000003', 'photos', 'a.txt'))) throw new Error('用户数据被删')
  if (existsSync(join(root, '20260101-000001'))) throw new Error('该删的旧快照没删')
  if (!existsSync(join(root, '20260101-000002'))) throw new Error('最新快照被删了')
  if (r.kept !== 1) throw new Error(`kept=${r.kept}`)
  if (!r.skipped.includes('20260101-000003')) throw new Error('skipped 没记下来')
  return true
})

await checkAsync('TOOL_VERSION 跟 package.json 一致（读到的是真版本）', async () => {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (TOOL_VERSION !== pkg.version) throw new Error(`TOOL_VERSION=${TOOL_VERSION}，package=${pkg.version}`)
  return true
})

await checkAsync('apply() 在假 ctx 上不抛错，且注册了四个工具', async () => {
  const home = join(tmp, 'fakehome')
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = join(tmp, 'dshhome')
  mkdirSync(process.env.DSH_HOME, { recursive: true })
  const tools = []
  const effects = []
  const disposers = []
  const fakeCtx = {
    logger: () => ({ info: () => {} }),
    get: (n) => {
      if (n === 'dshHomePath') return (seg) => join(home, seg)
      return undefined
    },
    tools: {
      register: (def) => {
        tools.push(def)
        return () => {}
      },
    },
    effect: (fn, label) => { effects.push(fn); disposers.push(fn) },
  }
  const mod = await import('../lib/index.js')
  await mod.apply(fakeCtx)
  if (tools.length !== 4) throw new Error(`注册了 ${tools.length} 个工具`)
  const names = tools.map((t) => t.name).join(',')
  for (const want of ['dsh_archive_now', 'dsh_archive_status', 'dsh_archive_config', 'dsh_archive_import']) {
    if (!names.includes(want)) throw new Error(`缺少工具 ${want}（现有 ${names}）`)
  }
  for (const t of tools) {
    if (!t.parameters || t.parameters.type !== 'object') throw new Error(`${t.name} 的 parameters 不是 object 根`)
  }
  // 跑一次 status 工具的 execute（只读）
  const statusTool = tools.find((t) => t.name === 'dsh_archive_status')
  const s = await statusTool.execute({})
  if (!s || s.ok !== true) throw new Error('status 工具没返回 ok')
  if (!s.counts || typeof s.counts.skills !== 'number') throw new Error('status 缺 counts')
  // 卸载
  for (const fn of effects) { const off = fn(); if (typeof off === 'function') off() }
  return true
})

rmSync(tmp, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '通过' : '失败'}：${pass} 项通过，${fail} 项失败`)
process.exitCode = fail === 0 ? 0 : 1
if (fail === 0) console.log('（自检只覆盖本插件自己的逻辑，宿主里还有一次真实重启验证）')
void root
