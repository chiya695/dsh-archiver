/**
 * lib/hostdeps.mjs —— 从宿主那棵树里借 `defineTool`（借不到就用本地等价实现）
 * ============================================================================
 * 为什么不能裸 import `@deepseek-ai/dsh-tools`：
 *   桌面版 profile 是 `autoInstallPeers: false`，插件被 link 进去时不会装 peer；
 *   裸 import 一旦解析失败就是「整条 entry 不激活」，代价太大。
 *
 * 所以：先按几个已知位置把宿主那份 dsh-tools 找出来（跟宿主用同一份，行为最一致）；
 * 找不到就用本文件的 localDefineTool（形状与 defineTool 的输出一致：
 * parameters 是 object 根 JSON Schema，output.schema 也是）。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的地方 */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  // Electron 桌面版：resources/app/dsh/node_modules/@deepseek-ai（真实目录）
  const res = process.env.DSH_RESOURCES_PATH || process.resourcesPath
  if (res) {
    push(join(res, 'app', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(res, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(res, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(res, 'runtime', 'node_modules', '@deepseek-ai'))
  }

  // npm 全局装的 dsh
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')

  // profile 树（有些机器上被别的插件 hoist 到了 profile 根）
  for (const dshHome of [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)) {
    try {
      for (const p of readdirSync(join(dshHome, 'profiles'))) {
        push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }

  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name, log) {
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log?.(`${name}：从宿主树取到（${url.replace(/^file:\/+/, '')}）`)
      return mod
    } catch { /* 继续试下一个根 */ }
  }
  return null
}

function compileSpec(spec) {
  if (!spec || typeof spec !== 'object') return {}
  const node = {}
  if (spec.type && spec.type !== 'json') node.type = spec.type
  if (spec.description) node.description = spec.description
  if (Array.isArray(spec.enum)) node.enum = [...spec.enum]
  if (spec.items) node.items = compileSpec(spec.items)
  if (spec.oneOf) node.oneOf = spec.oneOf.map(compileSpec)
  if (spec.type === 'object') {
    const props = {}
    for (const [k, v] of Object.entries(spec.properties || {})) props[k] = compileSpec(v)
    node.properties = props
    node.additionalProperties = spec.additionalProperties === true
  }
  return node
}

/** 本地等价实现：只在借不到宿主 dsh-tools 时用 */
export function localDefineTool(options) {
  const props = {}
  const required = []
  for (const [k, v] of Object.entries(options.parameters || {})) {
    props[k] = compileSpec(v)
    if (v?.required === true) required.push(k)
  }
  const parameters = { type: 'object', properties: props, ...(required.length ? { required } : {}) }
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: options.output || {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    execute: options.execute,
  }
}

/** 拿 defineTool：优先宿主那份，拿不到用本地 */
export async function loadDefineTool(log) {
  const mod = await fromHostTree('dsh-tools', log)
  if (mod?.defineTool) return mod.defineTool
  log?.('defineTool：宿主树里没找到，用本地等价实现')
  return localDefineTool
}

/** 统一的文本输出形状（模型侧直接读 JSON 文本） */
export const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}
