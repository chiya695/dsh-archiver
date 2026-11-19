/**
 * lib/scan.mjs —— 找出「DSH 里有哪些技能、哪些插件」
 * ============================================================================
 * 技能来源（对齐 @deepseek-ai/dsh-skill-filesystem 的根顺序，另加插件自带）：
 *   · $DSH_HOME/skills                      用户级
 *   · ~/.agents/skills                      跨 agent 公共根（DSH_AGENTS_HOME 可覆盖）
 *   · <project>/.dsh/skills                 项目级
 *   · <project>/.agents/skills              项目级（跨 agent）
 *   · sources.extraSkillRoots               自定义
 *   · <runtime>/office-skills               运行时自带（office-docx/pptx/xlsx）
 *   · DSH_BUNDLED_SKILL_DIR                 部署方指定的自带技能根
 *   · <plugin>/skills/<name>                插件自带的技能（如 dsh-browser）
 *
 * 插件来源：当前 profile 的 package.json —— `dependencies`（装了）∪
 * `dsh.profile.bundles`（启用了），逐个到 profile/node_modules 或
 * DSH 安装目录里解析真实目录。
 * ============================================================================
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readJson } from './state.mjs'

const SKILL_MD = ['SKILL.md', 'skill.md', 'Skill.md']

/** 读 SKILL.md 的 YAML frontmatter（只取 name / description，够用了） */
export function readSkillMeta(skillMdPath) {
  let raw = ''
  try { raw = readFileSync(skillMdPath, 'utf8') } catch { return {} }
  const meta = {}
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw)
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
      if (!m) continue
      let value = m[2].trim()
      if (!value) continue
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (m[1] === 'name' || m[1] === 'description') meta[m[1]] = value
    }
  }
  if (!meta.description) {
    const body = fm ? raw.slice(fm[0].length) : raw
    const line = body.split(/\r?\n/).map((s) => s.replace(/^#+\s*/, '').trim()).find(Boolean)
    if (line) meta.description = line.slice(0, 240)
  }
  return meta
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

function isFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

/** zip 文件名里不能出现的字符 */
export function safeZipBase(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'unnamed'
}

function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}

function appNodeModules() {
  const res = process.env.DSH_RESOURCES_PATH || process.resourcesPath
  if (!res) return ''
  return join(res, 'app', 'dsh', 'node_modules')
}

function bundledRuntimeSkills() {
  const res = process.env.DSH_RESOURCES_PATH || process.resourcesPath
  const out = []
  if (res) out.push(join(res, 'runtime', 'office-skills'))
  if (process.env.DSH_BUNDLED_SKILL_DIR) out.push(process.env.DSH_BUNDLED_SKILL_DIR)
  return out
}

/**
 * 列出插件。
 * @param {{profileDir:string, cfg:object}} o
 */
export function discoverPlugins({ profileDir, cfg }) {
  const pkg = readJson(join(profileDir, 'package.json'), {}) || {}
  const activeList = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
  const depList = Object.keys(pkg?.dependencies || {})
  const active = new Set(activeList)
  const names = []
  for (const n of [...activeList, ...depList]) if (typeof n === 'string' && n && !names.includes(n)) names.push(n)

  const appNM = appNodeModules()
  const out = []
  const notes = []

  for (const name of names) {
    const candidates = [join(profileDir, 'node_modules', name)]
    if (appNM) candidates.push(join(appNM, name))
    let dir = ''
    for (const c of candidates) if (isDir(c)) { dir = c; break }
    if (!dir) { notes.push(`插件未落地，跳过：${name}`); continue }

    const isBuiltin = name.startsWith('@deepseek-ai/')
    if (isBuiltin && !cfg?.sources?.includeBuiltinPlugins) {
      notes.push(`自带基础包按配置跳过：${name}`)
      continue
    }

    let version = ''
    let description = ''
    try {
      const p = readJson(join(dir, 'package.json'), {}) || {}
      version = typeof p.version === 'string' ? p.version : ''
      description = typeof p.description === 'string' ? p.description.slice(0, 200) : ''
    } catch { /* ignore */ }

    out.push({
      kind: 'plugin',
      name,
      zipBase: safeZipBase(name.replace(/\//g, '__')),
      dir,
      version,
      description,
      origin: isBuiltin ? 'builtin' : 'profile',
      active: active.has(name),
    })
  }

  return { plugins: out, notes }
}

/**
 * 列技能（含插件自带的）。
 * @param {{dshHome:string, cfg:object, plugins?:Array}} o
 */
export function discoverSkills({ dshHome, cfg, plugins = [] }) {
  const roots = []
  const push = (path, origin, label) => {
    if (!path) return
    roots.push({ path, origin, label })
  }

  push(join(dshHome, 'skills'), 'user-dsh', '$DSH_HOME/skills')
  if (cfg?.sources?.includeAgentsSkills !== false) push(join(agentsHome(), 'skills'), 'user-agents', '~/.agents/skills')

  const cwd = (cfg?.sources?.projectCwd || '').trim()
  if (cwd) {
    push(join(cwd, '.dsh', 'skills'), 'project-dsh', '<project>/.dsh/skills')
    push(join(cwd, '.agents', 'skills'), 'project-agents', '<project>/.agents/skills')
  }

  for (const extra of cfg?.sources?.extraSkillRoots || []) {
    push(extra, 'extra', extra)
  }

  if (cfg?.sources?.includeBundledSkills !== false) {
    for (const p of bundledRuntimeSkills()) push(p, 'bundled', p)
  }

  for (const plugin of plugins) {
    const p = join(plugin.dir, 'skills')
    if (isDir(p)) push(p, `plugin:${plugin.name}`, `${plugin.name}/skills`)
  }

  const skills = []
  const used = new Set()
  const notes = []

  const add = (candidate) => {
    let base = candidate.zipBase
    if (used.has(base)) {
      const tag = candidate.origin.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 32)
      base = `${candidate.zipBase}~${tag}`
      let n = 2
      while (used.has(base)) base = `${candidate.zipBase}~${tag}-${n++}`
    }
    used.add(base)
    skills.push({ ...candidate, zipBase: base })
  }

  for (const root of roots) {
    if (!isDir(root.path)) continue
    let items
    try { items = readdirSync(root.path, { withFileTypes: true }) } catch {
      notes.push(`读技能根失败：${root.path}`)
      continue
    }
    for (const item of items) {
      const full = join(root.path, item.name)
      if (isDir(full)) {
        const md = SKILL_MD.map((f) => join(full, f)).find((p) => isFile(p))
        if (!md) continue
        const meta = readSkillMeta(md)
        add({
          kind: 'skill',
          name: meta.name || item.name,
          zipBase: safeZipBase(meta.name || item.name),
          dir: full,
          origin: root.origin,
          originLabel: root.label,
          description: meta.description || '',
        })
      } else if (/\.md$/iu.test(item.name) && !/^skill\.md$/iu.test(item.name) && isFile(full)) {
        const meta = readSkillMeta(full)
        const base = item.name.replace(/\.md$/iu, '')
        add({
          kind: 'skill',
          name: meta.name || base,
          zipBase: safeZipBase(meta.name || base),
          file: full,
          origin: root.origin,
          originLabel: root.label,
          description: meta.description || '',
        })
      }
    }
  }

  return { skills, roots, notes }
}

/** 一次拿齐（run / status 共用） */
export function discoverAll({ dshHome, profileDir, cfg }) {
  const { plugins, notes: pluginNotes } = discoverPlugins({ profileDir, cfg })
  const { skills, roots, notes: skillNotes } = discoverSkills({ dshHome, cfg, plugins })
  return {
    plugins,
    skills,
    roots,
    notes: [...pluginNotes, ...skillNotes],
  }
}
