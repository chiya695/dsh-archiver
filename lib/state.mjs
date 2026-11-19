/**
 * lib/state.mjs —— 插件的"家"
 * ============================================================================
 * 规矩：配置、状态、日志、产物全部落在 `$DSH_HOME/dsh-archiver/`，
 * **绝不写进插件包目录**（装进 node_modules 后可能只读，升级也会被覆盖）。
 *
 * 目录形状：
 *   $DSH_HOME/dsh-archiver/
 *     config.json      配置（唯一真相源）
 *     state.json       最近若干次运行的记录（触发节流 / 面板用）
 *     log/archiver.log 追加日志（超 2MB 自动轮转一次）
 *     out/             默认落地目录（可在 config.local.root 改到别处）
 *     tmp/             原子写盘的临时区
 * ============================================================================
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  appendFileSync, statSync, rmSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

/** 家目录下要预建的子目录 */
const SUBDIRS = ['out', 'log', 'tmp']

/**
 * 解析插件家目录。
 *
 * ⚠️ `ctx.get('dshHomePath')` 返回的是**函数**而不是字符串：
 *    `dshHomePath(...segments) => join(resolveDshHome(), ...segments)`
 *    当字符串用会把函数源码当路径 ⇒ mkdir ENOENT。
 *
 * @param {object|null} ctx cordis 上下文（CLI 场景可传 null）
 * @param {string} [name] 插件家目录名
 * @returns {string} 绝对路径（不保证已存在）
 */
export function stateDirOf(ctx, name = 'dsh-archiver') {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p(name)
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, name)
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), name)
  return dir
}

/** 解析 DSH_HOME（CLI 场景没有 ctx 时用） */
export function dshHomePath() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

/** 解析当前 profile 目录 */
export function profileDirPath() {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (fromEnv) return fromEnv
  const name = process.env.DSH_PROFILE || 'desktop'
  return join(dshHomePath(), 'profiles', name)
}

export function ensureDirs(home) {
  for (const d of SUBDIRS) {
    try { mkdirSync(join(home, d), { recursive: true }) } catch { /* ignore */ }
  }
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 原子写 JSON：先写 tmp 再 rename —— 半截文件比没有文件更糟 */
export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 原子写二进制 */
export function writeBinary(file, buffer) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, buffer)
  renameSync(tmp, file)
}

const LOG_MAX_BYTES = 2 * 1024 * 1024

/** 追加日志；超过 2MB 轮转成 .1（只保留一代） */
export function appendLog(home, line) {
  try {
    const f = join(home, 'log', 'archiver.log')
    mkdirSync(dirname(f), { recursive: true })
    try {
      if (existsSync(f) && statSync(f).size > LOG_MAX_BYTES) {
        const old = `${f}.1`
        if (existsSync(old)) rmSync(old, { force: true })
        renameSync(f, old)
      }
    } catch { /* 轮转失败不影响写日志 */ }
    appendFileSync(f, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* 日志永远不许打断业务 */ }
}

export function logFile(home) {
  return join(home, 'log', 'archiver.log')
}

/** 读日志尾部若干行 */
export function tailLog(home, lines = 40) {
  try {
    const text = readFileSync(logFile(home), 'utf8')
    const all = text.split(/\r?\n/).filter(Boolean)
    return all.slice(-Math.max(1, lines))
  } catch { return [] }
}

/** 运行 id：20261117-153012（本地时间，便于肉眼对齐） */
export function runIdNow(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function nowIso() {
  return new Date().toISOString()
}
