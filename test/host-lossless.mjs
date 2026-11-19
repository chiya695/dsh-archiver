#!/usr/bin/env node
/**
 * test/host-lossless.mjs —— 用**宿主自己的**校验器验工具输出
 * ============================================================================
 * 背景：宿主对工具返回值跑 `snapshotJsonValue()`，任何一个 undefined / NaN /
 * Date / 循环引用都会让整次调用失败，报
 *   tool "xxx" returned invalid output: value is not lossless JSON
 * （2026-11-17 真的踩过：报告里 `version: undefined` 就把 dsh_archive_now 打回去了。）
 *
 * 这里直接借宿主那份 @deepseek-ai/dsh-util-values 的 isJsonValue / snapshotJsonValue，
 * 而不是自己写一个"差不多"的检查。
 *
 * 用法：node test/host-lossless.mjs
 * ============================================================================
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { loadCfg, DEFAULTS } from '../lib/config.mjs'
import { runArchive } from '../lib/run.mjs'

// 只从环境推导宿主安装位置，不在仓库里写死任何人的用户目录
const roots = [
  process.env.DSH_RESOURCES_PATH,
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources') : '',
  process.env.ProgramFiles ? join(process.env.ProgramFiles, 'DeepSeek Harness', 'resources') : '',
].filter(Boolean)

const candidates = roots.flatMap((r) => [
  join(r, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js'),
  join(r, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-util-values', 'lib', 'index.js'),
])

const hit = candidates.find((p) => existsSync(p))
if (!hit) {
  console.log('跳过：没找到宿主的 dsh-util-values（这是给本机验证用的，不是运行期依赖）')
  process.exit(0)
}

const { isJsonValue, snapshotJsonValue } = await import(pathToFileURL(hit).href)

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}`) }
}

// ① 先证明这个校验器确实会咬住 undefined（复现当初的失败形态）
ok(isJsonValue({ a: 1 }) === true, '正常对象通过')
ok(isJsonValue({ a: undefined }) === false, '含 undefined 的对象被拒（这就是当初的失败形态）')
ok(isJsonValue({ a: NaN }) === false, '含 NaN 的对象被拒')
ok(isJsonValue({ a: new Date() }) === false, '含 Date 的对象被拒')
ok(snapshotJsonValue({ a: undefined }) === undefined, 'snapshotJsonValue 对 undefined 字段返回 undefined')

// ② 真实归档报告必须通过
const tmp = mkdtempSync(join(tmpdir(), 'dsh-archiver-lossless-'))
try {
  const home = join(tmp, 'home')
  const cfg = { ...loadCfg(home), local: { ...DEFAULTS.local, root: join(tmp, 'out') } }
  const report = await runArchive({ home, cfg, why: 'lossless', dryRun: true })
  ok(isJsonValue(report) === true, 'dsh_archive_now 的报告是无损 JSON')
  const snap = snapshotJsonValue(report)
  ok(snap !== undefined && snap.counts.packaged === report.counts.packaged, 'snapshot 后数据不变')

  const status = JSON.parse(JSON.stringify(report))
  ok(isJsonValue(status) === true, '（对照）status 形态的对象同样通过')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n宿主校验器通过' : `\n宿主校验器失败 ${failures} 项`)
process.exitCode = failures === 0 ? 0 : 1
