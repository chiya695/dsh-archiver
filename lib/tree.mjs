/**
 * lib/tree.mjs —— 把一个目录拍平成 zip 条目
 * ============================================================================
 * 三个坑，逐个按住：
 *  ① **junction / symlink**：profile 里的插件常常是链接到本地插件目录的，
 *     `withFileTypes` 只会说是 symlink ⇒ 必须 stat 一次判类型，否则整包会空。
 *  ② **环**：链接指回上层会无限递归 ⇒ 用 realpath 集合挡环。
 *  ③ **大文件**：node_modules 里的二进制、模型权重——按 maxFileBytes 跳过并记账，
 *     绝不因为一个 300MB 的文件把整次归档拖死。
 * ============================================================================
 */
import { readdirSync, statSync, realpathSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Windows 保留设备名：叫这些名字的文件能创建、但删不掉（`Remove-Item` 报"函数不正确"），
 * 一旦进了备份包，导入时又会把坑种回来。所以打包和导入两头都按**全名**挡掉。
 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export function isReservedName(name) {
  const base = String(name || '').split('.')[0].trim().toLowerCase()
  return RESERVED.has(base)
}

/**
 * zip 的条目数是 16 位字段（最大 65535），超过就得 Zip64 —— 本插件不写 Zip64。
 * 所以这里留出余量封顶 65000，宁可明确报错也不要写出一个坏包。
 */
export const MAX_ENTRIES = 65000

/** exclude 统一按「全名、大小写不敏感」匹配 */
function excludeSet(list) {
  return new Set((list || [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim().toLowerCase()))
}

/**
 * @param {string} rootDir 源目录
 * @param {object} [options]
 * @param {string} [options.prefix] zip 内路径前缀（不带尾部斜杠也可以）
 * @param {string[]} [options.exclude] 名字**全等**就跳过（大小写不敏感）
 * @param {number} [options.maxFileBytes] 单文件大小上限
 * @param {number} [options.maxFiles] 条目数上限（防御性）
 * @param {number} [options.maxDepth] 递归深度上限
 * @returns {{entries:Array<{name:string,data:Buffer,mtime:Date}>,stats:object}}
 */
export function collectTree(rootDir, options = {}) {
  const prefix = String(options.prefix || '').replace(/\\/g, '/').replace(/\/+$/, '')
  // exclude 按「名字全等」匹配（大小写不敏感）。以前用 includes，导致 .github/.gitlab
  // 被 '.git' 顺手吃掉，备份里悄悄缺文件。
  const exclude = excludeSet(options.exclude)
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : 64 * 1024 * 1024
  const maxFiles = Number.isFinite(options.maxFiles) ? Math.min(options.maxFiles, MAX_ENTRIES) : MAX_ENTRIES
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 24

  const entries = []
  const warnings = []
  const seenReal = new Set()
  const stats = { files: 0, bytes: 0, dirs: 0, skippedFiles: 0, skippedBytes: 0, skippedDirs: 0 }

  const hitExclude = (name) => exclude.has(String(name).toLowerCase()) || isReservedName(name)

  const walk = (dir, depth) => {
    if (depth > maxDepth) {
      warnings.push(`目录层级过深，已跳过：${relative(rootDir, dir) || '.'}`)
      return
    }
    let real
    try { real = realpathSync(dir) } catch { return }
    if (seenReal.has(real)) return
    seenReal.add(real)

    let items
    try { items = readdirSync(dir, { withFileTypes: true }) } catch (e) {
      warnings.push(`读目录失败：${relative(rootDir, dir) || '.'}（${e?.code || e?.message}）`)
      return
    }

    for (const item of items) {
      if (hitExclude(item.name)) continue
      const full = join(dir, item.name)
      let st
      try { st = statSync(full) } catch { continue } // 断链

      if (st.isDirectory()) {
        stats.dirs++
        walk(full, depth + 1)
        continue
      }
      if (!st.isFile()) continue

      if (st.size > maxFileBytes) {
        stats.skippedFiles++
        stats.skippedBytes += st.size
        warnings.push(`跳过超大文件：${relative(rootDir, full)}（${(st.size / 1048576).toFixed(1)}MB）`)
        continue
      }
      if (entries.length >= maxFiles) {
        warnings.push(`条目数超过上限 ${maxFiles}，后续文件未收`)
        return
      }
      try {
        const data = readFileSync(full)
        const rel = relative(rootDir, full).split(sep).join('/')
        const name = prefix ? `${prefix}/${rel}` : rel
        entries.push({ name, data, mtime: st.mtime })
        stats.files++
        stats.bytes += data.length
      } catch (e) {
        warnings.push(`读文件失败：${relative(rootDir, full)}（${e?.code || e?.message}）`)
      }
    }
  }

  walk(rootDir, 0)
  return { entries, stats, warnings }
}

/** 目录体积估算（状态页用，不读内容） */
export function dirSize(rootDir, options = {}) {
  const exclude = excludeSet(options.exclude)
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 12
  let files = 0
  let bytes = 0
  const seenReal = new Set()

  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let real
    try { real = realpathSync(dir) } catch { return }
    if (seenReal.has(real)) return
    seenReal.add(real)
    let items
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (exclude.has(item.name.toLowerCase()) || isReservedName(item.name)) continue
      const full = join(dir, item.name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (st.isFile()) { files++; bytes += st.size }
    }
  }
  walk(rootDir, 0)
  return { files, bytes }
}

/**
 * 源目录指纹（增量归档用）。
 * 只 stat 不读内容：文件数 + 总字节 + 最新 mtime 三者一致就认为"没变"。
 * 比读一遍所有文件便宜两个数量级，够用来跳过无意义的重复压缩。
 *
 * @param {string} rootDir
 * @param {{exclude?:string[], maxDepth?:number}} [options]
 * @returns {string} 形如 "203:12004321:1763371200000"
 */
export function sourceSignature(rootDir, options = {}) {
  const exclude = excludeSet(options.exclude)
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 24
  let files = 0
  let bytes = 0
  let mtimeMax = 0
  const seenReal = new Set()

  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let real
    try { real = realpathSync(dir) } catch { return }
    if (seenReal.has(real)) return
    seenReal.add(real)
    let items
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (exclude.has(item.name.toLowerCase()) || isReservedName(item.name)) continue
      const full = join(dir, item.name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (st.isFile()) {
        files++
        bytes += st.size
        if (st.mtimeMs > mtimeMax) mtimeMax = st.mtimeMs
      }
    }
  }
  walk(rootDir, 0)
  return `${files}:${bytes}:${Math.round(mtimeMax)}`
}

