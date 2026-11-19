/**
 * lib/importer.mjs —— 把本插件导出的备份「导入回来」
 * ============================================================================
 * 支持三种来源：
 *   · 一份导出根目录（flat 布局的 <root>，里面有 skills/ 与 plugins/）
 *   · 一份历史快照目录（<root>/history/<runId>/ 或 run 布局的 <root>/<runId>/）
 *   · 单个 .zip（本插件产出的技能包或插件包）
 *
 * 导入规则：
 *   · 技能 → 解压到技能根（默认 $DSH_HOME/skills），DSH 的文件系统技能提供器会自动发现；
 *   · 插件 → 解压到「插件导入目录」（默认 $DSH_HOME/dsh-archiver/imported-plugins/<包名>），
 *     并把 `dsh plugin --profile <当前> add link:<路径>` 这条命令一起返回 ——
 *     不擅自动用户的 profile / bundles / pnpm 树。
 *
 * 安全与可回滚：
 *   · 先解到 `<target>.importing-<pid>`，校验通过（SKILL.md / package.json 在）再改名；
 *   · 覆盖时把原来的目录改名成 `<target>.bak-<时间戳>`，不删除任何东西；
 *   · zip 条目里出现 `..`、绝对路径、盘符就整体拒绝。
 * ============================================================================
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
} from 'node:fs'
import { join, dirname, basename, relative, isAbsolute } from 'node:path'
import { readZip } from './zip.mjs'
import { readJson, writeBinary } from './state.mjs'
import { isReservedName } from './tree.mjs'

const RUN_ID_RE = /^\d{8}-\d{6}$/u

/**
 * 把"包名"洗成安全的相对路径段。
 * zip 里的 package.json 的 name 是内容提供的，可能是 `../../evil`、
 * `C:\Windows\...`、`con` 这类东西 —— 直接拿来拼目标路径就是路径穿越。
 */
export function safeTargetName(name, fallback) {
  const segs = String(name || '')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[<>:"|?*\x00-\x1f]/g, '_'))
    .filter(Boolean)
  if (!segs.length) {
    return String(fallback || 'unnamed').replace(/[<>:"|?*\x00-\x1f\\/]/g, '_') || 'unnamed'
  }
  // @scope/pkg 保留两段，其余只取一段（多出来的一律丢，防穿越）
  const picked = segs[0].startsWith('@') ? segs.slice(0, 2) : segs.slice(0, 1)
  if (picked.some((s) => isReservedName(s))) {
    return String(fallback || 'unnamed').replace(/[<>:"|?*\x00-\x1f\\/]/g, '_') || 'unnamed'
  }
  return picked.join('/')
}

/** 目标必须落在 root 之内（再做一次兜底，防 join 出花样） */
function assertInside(root, target) {
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`拒绝写入导入目录之外：${target}`)
  }
}

/** 技能/插件导入到哪儿 */
export function importRoots(cfg, home, dshHome) {
  const skills = (cfg?.sources?.skillImportRoot || '').trim() || join(dshHome || join(home, '..'), 'skills')
  const plugins = (cfg?.local?.pluginImportDir || '').trim() || join(home, 'imported-plugins')
  return { skills, plugins }
}

/**
 * 从 zip 里猜类型：根目录下有 package.json → 插件；有 SKILL.md → 技能。
 * `root` 是 zip 里的真实前缀（插件包名里的 / 被打包时换成了 __），
 * `name` 是"应该叫什么"——插件取 package.json 里的真包名（含 @scope/），技能取前缀。
 */
export function zipKind(zipPath) {
  const entries = readZip(readFileSync(zipPath))
  const names = entries.map((e) => e.name.replace(/\\/g, '/'))
  const root = (names[0] || '').split('/')[0] || ''
  const isPlugin = names.some((n) => /^[^/]+\/package\.json$/u.test(n))
  const isSkill = names.some((n) => /^[^/]+\/SKILL\.md$/iu.test(n))
  // 单文件技能：根下只有一个 .md（且不是 SKILL.md）。DSH 支持 skills 根下的裸 .md，
  // 导出时是 <名字>/<名字>.md —— 这条以前认不出来，导致这类技能备份导不回去。
  const mdAtDepth1 = names.filter((n) => /^[^/]+\/[^/]+\.md$/iu.test(n) && !/^[^/]+\/SKILL\.md$/iu.test(n))
  const isFlatSkill = !isSkill && !isPlugin && mdAtDepth1.length === 1 && names.length === mdAtDepth1.length
  // ⚠️ 技能包也可能带 package.json（archify 就是），所以先认 SKILL.md：
  //    根目录有 SKILL.md ⇒ 技能；否则有 package.json ⇒ 插件；否则单文件 .md ⇒ 单文件技能。
  const kind = isSkill || isFlatSkill ? 'skill' : (isPlugin ? 'plugin' : '')
  let version = ''
  let name = root
  if (kind === 'plugin') {
    try {
      const pkgEntry = entries.find((e) => /^[^/]+\/package\.json$/u.test(e.name.replace(/\\/g, '/')))
      const pkg = JSON.parse(pkgEntry.data.toString('utf8'))
      version = typeof pkg.version === 'string' ? pkg.version : ''
      if (typeof pkg.name === 'string' && pkg.name.trim()) name = pkg.name.trim()
    } catch { /* 版本/名字拿不到不影响导入 */ }
  } else if (isFlatSkill) {
    name = basename(mdAtDepth1[0], '.md')
  }
  return {
    kind,
    flatMd: isFlatSkill,
    root,
    mdName: isFlatSkill ? basename(mdAtDepth1[0]) : '',
    name,
    entries: entries.length,
    bytes: entries.reduce((n, e) => n + e.size, 0),
    version,
    manifest: entries.find((e) => e.name.replace(/\\/g, '/') === `${root}/SKILL.md`)?.data?.toString('utf8') || '',
  }
}

/**
 * 扫一个目录里的 zip：支持 flat 根、快照目录、直接一堆 zip。
 * 也会下钻一层时间戳目录 —— 这样把「run 布局的保存目录」整根丢进来也能扫到
 * （以前只认 <root>/skills|plugins，run 布局的 zip 在 <root>/<时间戳>/skills 里，扫出来是 0）。
 */
function scanDirForZips(dir, depth = 0) {
  const out = []
  const subdirs = []
  const snapshots = []
  let items = []
  try { items = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const ent of items) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'skills' || ent.name === 'plugins') subdirs.push(full)
      else if (depth < 1 && RUN_ID_RE.test(ent.name)) snapshots.push(full)
    } else if (ent.isFile() && /\.zip$/iu.test(ent.name)) out.push(full)
  }
  for (const sd of subdirs) {
    try {
      for (const ent of readdirSync(sd, { withFileTypes: true })) {
        if (ent.isFile() && /\.zip$/iu.test(ent.name)) out.push(join(sd, ent.name))
      }
    } catch { /* ignore */ }
  }
  for (const sp of snapshots) out.push(...scanDirForZips(sp, depth + 1))
  return [...new Set(out)]
}

/**
 * 预览：扫来源 → 每个包算出「会放到哪、是否已存在」。
 * @returns {{ok:boolean, source:object, items:Array, notes:string[], error?:string}}
 */
export function scanImportSource({ source, home, dshHome, cfg }) {
  const notes = []
  const path = String(source?.path || '').trim()
  if (!path) return { ok: false, source, items: [], notes, error: '没有填来源路径' }
  if (!existsSync(path)) return { ok: false, source, items: [], notes, error: `路径不存在：${path}` }

  const roots = importRoots(cfg, home, dshHome)
  let zipPaths = []
  const st = statSync(path)
  if (st.isDirectory()) {
    zipPaths = scanDirForZips(path)
    // 如果这个目录本身就是某个快照：<dir>/skills 与 <dir>/plugins 已经由上面覆盖
    if (!zipPaths.length) notes.push(`目录里没找到 .zip：${path}`)
  } else if (/\.zip$/iu.test(path)) {
    zipPaths = [path]
  } else {
    return { ok: false, source, items: [], notes, error: '来源必须是目录或 .zip 文件' }
  }

  const items = []
  for (const zipPath of zipPaths) {
    try {
      const info = zipKind(zipPath)
      if (!info.kind) { notes.push(`跳过（既不像技能包也不像插件包）：${basename(zipPath)}`); continue }
      const destRoot = info.kind === 'skill' ? roots.skills : roots.plugins
      const safeName = safeTargetName(info.name, basename(zipPath, '.zip'))
      // 单文件技能落成 <技能根>/<名字>.md，其余落成 <根>/<名字>/
      const target = info.flatMd
        ? join(destRoot, `${safeName}.md`)
        : join(destRoot, ...safeName.split('/'))
      items.push({
        kind: info.kind,
        flatMd: Boolean(info.flatMd),
        name: safeName,
        version: info.version || '',
        archive: zipPath,
        zipName: basename(zipPath),
        zipBytes: statSync(zipPath).size,
        entries: info.entries,
        bytes: info.bytes,
        target,
        exists: existsSync(target),
        renamedFrom: safeName !== info.name ? info.name : undefined,
      })
    } catch (e) {
      notes.push(`读不了这个 zip：${basename(zipPath)}（${String(e?.message || e).slice(0, 120)}）`)
    }
  }
  return {
    ok: true,
    source: { kind: st.isDirectory() ? 'dir' : 'zip', path },
    roots,
    items,
    notes,
  }
}

/** 把 zip 解到 tempDir（整段去掉根前缀，比如 archify/ 或 @scope/pkg/） */
function extractInto(zipBuffer, rootParts, tempDir) {
  const entries = readZip(zipBuffer)
  let files = 0
  let skippedReserved = 0
  for (const e of entries) {
    const raw = e.name.replace(/\\/g, '/')
    if (raw.endsWith('/')) continue
    const parts = raw.split('/').filter((p) => p && p !== '.')
    if (!parts.length) continue
    if (parts.some((p) => p === '..')) throw new Error(`zip 里出现可疑路径：${raw}`)
    if (raw.startsWith('/') || /^[a-zA-Z]:/u.test(parts[0])) throw new Error(`zip 里出现绝对路径：${raw}`)
    // 逐段剥掉根前缀（scoped 包是两段：@scope / pkg）
    let i = 0
    while (i < rootParts.length && parts[i] === rootParts[i]) i++
    const rest = parts.slice(i)
    if (!rest.length) continue
    // NUL / CON 这类 Windows 保留名：写进去就删不掉了，直接跳过（旧包里的坑）
    if (rest.some((p) => isReservedName(p))) { skippedReserved++; continue }
    const target = join(tempDir, ...rest)
    writeBinary(target, e.data)
    files++
  }
  return { files, skippedReserved }
}

/**
 * 真正导入。
 * @param {object} o
 * @param {string} o.home
 * @param {string} o.dshHome
 * @param {object} o.cfg
 * @param {Array} o.items     scanImportSource 的结果里挑出来的条目
 * @param {boolean} [o.overwrite] 已存在时是否覆盖（覆盖会把旧目录改名成 .bak-<时间戳>）
 * @param {Function} [o.log]
 */
export function runImport({ home, dshHome, cfg, items = [], overwrite = false, log = () => {} }) {
  const roots = importRoots(cfg, home, dshHome)
  const imported = []
  const skipped = []
  const failed = []

  for (const item of items) {
    const zipPath = String(item?.archive || '')
    try {
      if (!zipPath || !existsSync(zipPath)) throw new Error('zip 不存在')
      const buf = readFileSync(zipPath)
      const info = zipKind(zipPath)
      if (!info.kind) throw new Error('既不像技能包也不像插件包')
      const destRoot = info.kind === 'skill' ? roots.skills : roots.plugins
      // 目标目录用"应该叫什么"（插件取 package.json 的真包名），但它来自 zip 内容，必须先洗过
      const safeName = safeTargetName(info.name, basename(zipPath, '.zip'))
      const target = info.flatMd
        ? join(destRoot, `${safeName}.md`)
        : join(destRoot, ...safeName.split('/'))
      assertInside(destRoot, target)

      if (existsSync(target) && !overwrite) {
        skipped.push({ kind: info.kind, name: safeName, target, reason: '已存在（未勾选覆盖）' })
        continue
      }

      mkdirSync(destRoot, { recursive: true })
      const tempDir = join(destRoot, `.importing-${process.pid}-${Date.now().toString(36)}`)
      rmSync(tempDir, { recursive: true, force: true })
      mkdirSync(tempDir, { recursive: true })
      let files = 0
      let skippedReserved = 0
      try {
        const extracted = extractInto(buf, info.root.split('/').filter(Boolean), tempDir)
        files = extracted.files
        skippedReserved = extracted.skippedReserved

        let backup = ''

        if (info.flatMd) {
          // 单文件技能：temp 根下应该正好有一个 .md，改成 <名字>.md 落到技能根
          const mds = readdirSync(tempDir, { withFileTypes: true }).filter((e) => e.isFile() && /\.md$/iu.test(e.name))
          if (mds.length !== 1) throw new Error(`单文件技能包里应该有且只有一个 .md，实际 ${mds.length} 个`)
          const src = join(tempDir, mds[0].name)
          if (existsSync(target)) {
            backup = `${target}.bak-${Date.now().toString(36)}`
            renameSync(target, backup)
          }
          renameSync(src, target)
          rmSync(tempDir, { recursive: true, force: true })
          imported.push({ kind: 'skill', name: safeName, version: info.version || '', target, files, skippedReserved, backup, flatMd: true })
          log(`导入单文件技能 ${safeName} → ${target}（${backup ? `旧文件备份到 ${backup}` : '新写入'}）`)
          continue
        }

        // 校验：技能必须有 SKILL.md，插件必须有 package.json
        const marker = info.kind === 'skill' ? 'SKILL.md' : 'package.json'
        const hasMarker = (() => {
          const walk = (dir, depth) => {
            if (depth > 4) return false
            for (const ent of readdirSync(dir, { withFileTypes: true })) {
              if (ent.isFile() && ent.name.toLowerCase() === marker.toLowerCase()) return true
              if (ent.isDirectory() && walk(join(dir, ent.name), depth + 1)) return true
            }
            return false
          }
          return walk(tempDir, 0)
        })()
        if (!hasMarker) throw new Error(`解出来没有 ${marker}，不像一个可用的${info.kind === 'skill' ? '技能' : '插件'}`)

        if (existsSync(target)) {
          backup = `${target}.bak-${Date.now().toString(36)}`
          renameSync(target, backup)
        }
        mkdirSync(dirname(target), { recursive: true })
        renameSync(tempDir, target)
        imported.push({ kind: info.kind, name: safeName, version: info.version || '', target, files, skippedReserved, backup })
        log(`导入${info.kind === 'skill' ? '技能' : '插件'} ${safeName} → ${target}（${files} 个文件${skippedReserved ? `，跳过 ${skippedReserved} 个保留名文件` : ''}${backup ? `，旧版本备份到 ${backup}` : ''}）`)
      } catch (e) {
        rmSync(tempDir, { recursive: true, force: true })
        throw e
      }
    } catch (e) {
      failed.push({ kind: item?.kind || '', name: item?.name || basename(zipPath), error: String(e?.message || e).slice(0, 300) })
    }
  }

  // 插件导入后会给出落地命令，别替用户改 profile
  const profile = process.env.DSH_PROFILE || 'desktop'
  const pluginCommands = imported
    .filter((x) => x.kind === 'plugin')
    .map((x) => `dsh plugin --profile ${profile} add link:${x.target.replace(/\\/g, '/')}`)

  return {
    ok: failed.length === 0,
    overwrite: Boolean(overwrite),
    roots,
    imported,
    skipped,
    failed,
    pluginCommands,
  }
}

/** 历史快照目录清单（面板「历史版本」用） */
export function listSnapshots(rootDir) {
  if (!rootDir || !existsSync(rootDir)) return []
  let dirs = []
  try {
    dirs = readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && RUN_ID_RE.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse()
  } catch { return [] }
  return dirs.map((name) => {
    const dir = join(rootDir, name)
    const manifest = readJson(join(dir, 'manifest.json'), null)
    let files = 0
    let bytes = 0
    const walk = (d, depth) => {
      if (depth > 4) return
      let items = []
      try { items = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const ent of items) {
        const full = join(d, ent.name)
        if (ent.isDirectory()) walk(full, depth + 1)
        else if (ent.isFile()) {
          files++
          try { bytes += statSync(full).size } catch { /* ignore */ }
        }
      }
    }
    walk(dir, 0)
    return {
      name,
      dir,
      at: manifest?.at || '',
      packaged: manifest?.counts?.packaged ?? null,
      zipBytes: manifest?.totals?.zipBytes ?? null,
      files,
      bytes,
    }
  })
}
