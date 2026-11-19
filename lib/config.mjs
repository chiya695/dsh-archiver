/**
 * lib/config.mjs —— 配置（唯一真相源：$DSH_HOME/dsh-archiver/config.json）
 * ============================================================================
 * 为什么不用 cordis 的 Config：
 *   DSH 的设置层只投影 `volatile` 字段，写错一个字段（比如 `.min()` 校验不过）
 *   就是「整条 entry 不激活」，代价远大于收益。这里用纯 JSON：
 *   读的时候 deep-merge 默认值，写的时候只覆盖用户改过的那一项。
 *
 * 所有取值都过一遍 clamp —— 配置文件被手改成负数/字符串也不会把定时器搞崩。
 * ============================================================================
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './state.mjs'
import { fieldKeys } from './schema.mjs'

export const CONFIG_VERSION = 1

export const DEFAULTS = {
  /** 总开关：关掉只停自动归档，手动仍可用 */
  enabled: true,

  /** 归档对象 */
  targets: { skills: true, plugins: true },

  /** 落地位置：local | webdav | both */
  dest: 'local',

  local: {
    /** 空 = $DSH_HOME/dsh-archiver/out */
    root: '',
    /** flat：稳定文件名，直接覆盖；run：每次一个 <runId>/ 目录 */
    layout: 'flat',
    /**
     * 历史版本：额外保留最近 N 份快照（0 = 只留最新）。
     *  · flat 下快照落在 <root>/history/<runId>/
     *  · run 布局本身就是快照，N 决定保留几份
     * 旧的 keepRuns 会被自动搬到这里（见 normalizeCfg）
     */
    keepVersions: 0,
    /** 导入插件时解压到哪儿；空 = $DSH_HOME/dsh-archiver/imported-plugins */
    pluginImportDir: '',
  },

  webdav: {
    enabled: false,
    /** 例如 https://dav.jianguoyun.com/dav/ 或 https://example.com/remote.php/dav/files/user */
    url: '',
    username: '',
    /** 直接写密码（不推荐）；也可留空、改用 passwordEnv */
    password: '',
    /** 从环境变量取密码（推荐），默认 DSH_ARCHIVER_WEBDAV_PASSWORD */
    passwordEnv: 'DSH_ARCHIVER_WEBDAV_PASSWORD',
    /** 远端根目录（会逐级 MKCOL 建出来） */
    root: 'dsh-archiver',
    timeoutMs: 60000,
  },

  auto: {
    /** DSH 启动后自动归档一次 */
    onStart: true,
    onStartDelayMs: 15000,
    /** 每隔几小时自动归档一次；0 = 不用这个节拍 */
    everyHours: 24,
    /** 每天定时（本地时间 HH:MM）；空 = 不用 */
    dailyAt: '',
    /** 两次自动归档之间的最小间隔（分钟），防抖 */
    minGapMinutes: 30,
  },

  zip: {
    /** deflate 级别 0–9（0 = 只存储） */
    level: 6,
    /** 单个文件超过这么多 MB 就跳过（node_modules 之类先被 exclude 挡掉） */
    maxFileMB: 64,
    /** 源目录没变化就复用上次的包（仅 flat 布局 + 本地落地时生效） */
    skipUnchanged: false,
    /** 目录/文件名里只要含这些片段就跳过（Windows 保留名 NUL/CON 等在 tree.mjs 里单独按全名挡） */
    exclude: ['node_modules', '.git', '.pnpm', '.turbo', '.cache', '.DS_Store', 'Thumbs.db'],
  },

  /** 手动模式的默认值（工具 / 面板「立即归档」/ CLI 共用） */
  manual: {
    /** all | skills | plugins */
    defaultTargets: 'all',
    /** 手动触发时默认只扫描不写盘 */
    dryRun: false,
    /** 手动跑完自动打开产物目录 */
    openAfterRun: false,
  },

  sources: {
    /** 额外要扫的项目根（会去找 <cwd>/.dsh/skills 与 <cwd>/.agents/skills） */
    projectCwd: '',
    /** 额外技能根目录（每个子目录一个技能） */
    extraSkillRoots: [],
    /** 是否把 DSH 自带的 @deepseek-ai/* 基础包也各打一包（体积大，默认关） */
    includeBuiltinPlugins: false,
    /** 是否收 DSH 运行时自带的技能（office-docx 等） */
    includeBundledSkills: true,
    /** 是否收 ~/.agents/skills（跨 agent 公共技能根） */
    includeAgentsSkills: true,
    /** 导入技能时解压到哪儿；空 = $DSH_HOME/skills */
    skillImportRoot: '',
  },

  /** 其它 */
  manifest: true,
  verbose: false,
}

export function configFile(home) {
  return join(home, 'config.json')
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
}

/** 递归合并：默认值打底，用户值覆盖；数组整体替换 */
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? clone(base) : clone(over)
  const out = clone(base) || {}
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = clone(v)
  }
  return out
}

function clampNum(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 把任意输入锤回合法形状 */
export function normalizeCfg(raw) {
  const cfg = deepMerge(DEFAULTS, isObj(raw) ? raw : {})

  cfg.enabled = raw?.enabled === undefined ? DEFAULTS.enabled : Boolean(cfg.enabled)
  cfg.targets.skills = cfg.targets?.skills === undefined ? true : Boolean(cfg.targets.skills)
  cfg.targets.plugins = cfg.targets?.plugins === undefined ? true : Boolean(cfg.targets.plugins)
  cfg.dest = ['local', 'webdav', 'both'].includes(cfg.dest) ? cfg.dest : 'local'

  cfg.local.layout = ['flat', 'run'].includes(cfg.local.layout) ? cfg.local.layout : 'flat'
  cfg.local.root = typeof cfg.local.root === 'string' ? cfg.local.root.trim() : ''
  cfg.local.pluginImportDir = typeof cfg.local.pluginImportDir === 'string' ? cfg.local.pluginImportDir.trim() : ''
  // 历史版本份数：
  //  · 新键 keepVersions 优先；
  //  · 老配置里的 keepRuns 只有在"当初就是 run 布局"时才有意义（flat 下它从未生效），
  //    所以 flat 布局不搬它 —— 否则升级后突然开始攒历史版本，白占磁盘。
  const legacyKeep = isObj(raw?.local) ? raw.local.keepRuns : undefined
  const legacyLayout = isObj(raw?.local) ? raw.local.layout : undefined
  const keepRaw = (isObj(raw?.local) && raw.local.keepVersions !== undefined)
    ? raw.local.keepVersions
    : (legacyKeep !== undefined && legacyLayout === 'run' ? legacyKeep : DEFAULTS.local.keepVersions)
  cfg.local.keepVersions = Math.round(clampNum(keepRaw, 0, 500, 0))
  if (cfg.local.keepRuns !== undefined) delete cfg.local.keepRuns

  cfg.webdav.enabled = Boolean(cfg.webdav.enabled)
  cfg.webdav.url = typeof cfg.webdav.url === 'string' ? cfg.webdav.url.trim() : ''
  cfg.webdav.root = typeof cfg.webdav.root === 'string' ? cfg.webdav.root.trim() : 'dsh-archiver'
  cfg.webdav.timeoutMs = Math.round(clampNum(cfg.webdav.timeoutMs, 5000, 600000, 60000))

  cfg.auto.onStart = Boolean(cfg.auto.onStart)
  cfg.auto.onStartDelayMs = Math.round(clampNum(cfg.auto.onStartDelayMs, 0, 600000, 15000))
  cfg.auto.everyHours = clampNum(cfg.auto.everyHours, 0, 24 * 30, 24)
  cfg.auto.minGapMinutes = Math.round(clampNum(cfg.auto.minGapMinutes, 0, 10080, 30))
  cfg.auto.dailyAt = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(cfg.auto.dailyAt || '').trim())
    ? String(cfg.auto.dailyAt).trim().padStart(5, '0')
    : ''

  cfg.zip.level = Math.round(clampNum(cfg.zip.level, 0, 9, 6))
  cfg.zip.maxFileMB = Math.round(clampNum(cfg.zip.maxFileMB, 1, 4096, 64))
  cfg.zip.skipUnchanged = Boolean(cfg.zip.skipUnchanged)
  if (!Array.isArray(cfg.zip.exclude)) cfg.zip.exclude = clone(DEFAULTS.zip.exclude)
  cfg.zip.exclude = cfg.zip.exclude.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())

  cfg.manual.defaultTargets = ['all', 'skills', 'plugins'].includes(cfg.manual.defaultTargets)
    ? cfg.manual.defaultTargets
    : 'all'
  cfg.manual.dryRun = Boolean(cfg.manual.dryRun)
  cfg.manual.openAfterRun = Boolean(cfg.manual.openAfterRun)

  if (!Array.isArray(cfg.sources.extraSkillRoots)) cfg.sources.extraSkillRoots = []
  cfg.sources.extraSkillRoots = cfg.sources.extraSkillRoots.filter((x) => typeof x === 'string' && x.trim())
  cfg.sources.projectCwd = typeof cfg.sources.projectCwd === 'string' ? cfg.sources.projectCwd.trim() : ''
  cfg.sources.skillImportRoot = typeof cfg.sources.skillImportRoot === 'string' ? cfg.sources.skillImportRoot.trim() : ''
  cfg.manifest = Boolean(cfg.manifest)

  // dest=webdav 但没配地址 ⇒ 明确降级回本地，并在状态里报出来
  if (cfg.dest !== 'local' && (!cfg.webdav.enabled || !cfg.webdav.url)) cfg.dest = 'local'

  return cfg
}

export function loadCfg(home, { create = true } = {}) {
  const file = configFile(home)
  const existed = existsSync(file)
  const raw = readJson(file, null)
  const cfg = normalizeCfg(raw)
  // ⚠️ 以前这里比较的是 normalizeSignature(raw) 与 normalizeSignature(cfg)，
  //    两者其实是同一个东西（恒等），所以永远不回写 —— 配置文件里看不到新键、
  //    旧键（keepRuns）也一直留着。现在按「稳定序列化后是否不同」判断，写一次就收敛。
  if (create && (!existed || stableJson(raw) !== stableJson(cfg))) {
    try { saveCfg(home, cfg) } catch { /* 写不进去也不影响本次运行 */ }
  }
  return cfg
}

/** 键名排序后的 JSON（只用于比较，不受对象键顺序影响） */
function stableJson(value) {
  const seen = new WeakSet()
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    const out = {}
    for (const k of Object.keys(v).sort()) out[k] = walk(v[k])
    return out
  }
  try { return JSON.stringify(walk(value)) } catch { return '' }
}

export function saveCfg(home, cfg) {
  writeJson(configFile(home), normalizeCfg(cfg))
}

/** 点路径读：getPath(cfg, 'webdav.url') */
export function getPath(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean)
  let cur = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[p]
  }
  return cur
}

/** 点路径写：原地改 + 返回是否成功 */
export function setPath(obj, path, value) {
  const parts = String(path || '').split('.').filter(Boolean)
  if (!parts.length) return false
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (cur[p] === null || typeof cur[p] !== 'object' || Array.isArray(cur[p])) cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
  return true
}

/**
 * 按默认值的类型把字符串值转成目标类型。
 * CLI / 工具参数里拿到的都是字符串，手改 JSON 的人可以随便写对象。
 */
export function coerceValue(path, value) {
  const def = getPath(DEFAULTS, path)
  if (typeof value !== 'string') return value
  const raw = value.trim()
  if (typeof def === 'boolean') {
    if (/^(true|1|yes|on|开|是)$/i.test(raw)) return true
    if (/^(false|0|no|off|关|否)$/i.test(raw)) return false
    return Boolean(raw)
  }
  if (typeof def === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : value
  }
  if (Array.isArray(def)) {
    if (!raw) return []
    if (raw.startsWith('[')) {
      try {
        const arr = JSON.parse(raw)
        return Array.isArray(arr) ? arr : [raw]
      } catch { return [raw] }
    }
    return raw.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean)
  }
  if (def !== null && typeof def === 'object') {
    try { return JSON.parse(raw) } catch { return value }
  }
  return raw
}

/** 真正的落地根目录（绝对路径） */
export function resolveSaveRoot(cfg, home) {
  const raw = (cfg?.local?.root || '').trim()
  if (!raw) return join(home, 'out')
  return raw
}

/**
 * 给前端/工具看的配置：**抹掉 WebDAV 密码**，只留「有没有配」。
 * 密码是给服务器用的，没必要出现在浏览器页面（同页其它插件也能读到）或模型上下文里。
 */
export function redactConfig(cfg) {
  const out = clone(cfg) || {}
  if (out.webdav && typeof out.webdav === 'object') {
    const had = typeof out.webdav.password === 'string' && out.webdav.password.length > 0
    const envName = typeof out.webdav.passwordEnv === 'string' ? out.webdav.passwordEnv.trim() : ''
    const fromEnv = Boolean(envName && process.env[envName])
    out.webdav.password = ''
    out.webdav.hasPassword = had || fromEnv
    out.webdav.passwordFromEnv = Boolean(fromEnv)
  }
  return out
}

/**
 * 按「点路径 → 值」批量改配置并落盘（设置页保存走这条）。
 * 只接受 lib/schema.mjs 里登记过的键 —— 面板传错名字不会被写进 config.json。
 *
 * @param {string} home 插件家目录
 * @param {Record<string, unknown>} patch
 * @param {Function} [log]
 * @returns {{config:object, applied:string[], rejected:string[]}}
 */
export function applyPatch(home, patch, log = () => {}) {
  const allowed = new Set(fieldKeys())
  const cfg = loadCfg(home)
  const applied = []
  const rejected = []
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!allowed.has(key)) { rejected.push(key); continue }
    setPath(cfg, key, coerceValue(key, raw))
    applied.push(key)
  }
  saveCfg(home, cfg)
  const after = loadCfg(home)
  if (applied.length) log(`配置已更新：${applied.join(', ')}`)
  if (rejected.length) log(`拒绝未知配置项：${rejected.join(', ')}`)
  return { config: after, applied, rejected }
}
