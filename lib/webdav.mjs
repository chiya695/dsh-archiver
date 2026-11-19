/**
 * lib/webdav.mjs —— WebDAV 上传（只用标准方法：MKCOL / PUT / PROPFIND）
 * ============================================================================
 * 说明：
 *   · 密码优先取 `webdav.password`，为空时读 `webdav.passwordEnv` 指向的环境变量
 *     （推荐），这样配置文件和日志里都不会留明文；
 *   · 逐级 MKCOL 建目录，405/301/409 都当"已经存在"；
 *   · 每个请求独立超时；网络错误/5xx 退避重试 2 次，其余直接失败；
 *   · 任何单个文件失败都不影响其它文件，最后汇总成报告。
 * ============================================================================
 */

const DEFAULT_TIMEOUT = 60000

export function davPassword(cfg) {
  const w = cfg?.webdav || {}
  const direct = typeof w.password === 'string' ? w.password : ''
  if (direct) return direct
  const envName = typeof w.passwordEnv === 'string' ? w.passwordEnv.trim() : ''
  if (envName && process.env[envName]) return String(process.env[envName])
  return ''
}

export function davAuthHeader(cfg) {
  const user = String(cfg?.webdav?.username || '')
  const pass = davPassword(cfg)
  if (!user && !pass) return {}
  const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
  return { authorization: `Basic ${token}` }
}

/** 远端根 URL（已带 root 子目录，未带尾斜杠） */
export function davBaseUrl(cfg) {
  const url = String(cfg?.webdav?.url || '').trim().replace(/\/+$/u, '')
  if (!url) throw new Error('未配置 webdav.url')
  if (!/^https?:\/\//iu.test(url)) throw new Error('webdav.url 必须以 http:// 或 https:// 开头')
  const root = String(cfg?.webdav?.root || '')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return root ? `${url}/${root}` : url
}

function encodeRel(rel) {
  return String(rel)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

async function davRequest(cfg, method, url, { body, headers = {}, timeoutMs } = {}) {
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : Number(cfg?.webdav?.timeoutMs) || DEFAULT_TIMEOUT
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, {
      method,
      headers: { ...davAuthHeader(cfg), ...headers },
      body,
      signal: controller.signal,
      redirect: 'follow',
    })
  } finally {
    clearTimeout(timer)
  }
}

const OK_DAV = new Set([200, 201, 204, 207])

/**
 * 建目录（逐级）。已经存在返回 true。
 * 注意：`relDir` 为空时也会 MKCOL 一次远端根（有的服务不自动建父目录）。
 * @returns {Promise<{created:string[], existed:string[]}>}
 */
export async function ensureCollection(cfg, relDir = '') {
  const base = davBaseUrl(cfg)
  const created = []
  const existed = []

  const mkcol = async (url) => {
    const res = await davRequest(cfg, 'MKCOL', url)
    if (res.status === 201) created.push(url)
    else if ([301, 405, 409, 200, 204].includes(res.status)) existed.push(url)
    else {
      const text = await safeText(res)
      const err = new Error(`MKCOL ${url} 失败：${res.status} ${text}`)
      // 带上状态码，好让调用方（自检）翻译成"人话"
      err.status = res.status
      err.detail = text
      throw err
    }
  }

  await mkcol(base)

  const segments = String(relDir).replace(/\\/g, '/').split('/').filter(Boolean)
  let cur = base
  for (const seg of segments) {
    cur = `${cur}/${encodeURIComponent(seg)}`
    await mkcol(cur)
  }
  return { created, existed }
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300) } catch { return '' }
}

const ensuredCollections = new Set()

async function ensureOnce(cfg, relDir = '') {
  const key = `${davBaseUrl(cfg)}|${relDir}`
  if (ensuredCollections.has(key)) return
  await ensureCollection(cfg, relDir)
  ensuredCollections.add(key)
}

/** 带重试的 PUT */
export async function uploadBuffer(cfg, relPath, buffer, contentType = 'application/octet-stream') {
  const base = davBaseUrl(cfg)
  const rel = encodeRel(relPath)
  const url = `${base}/${rel}`
  const dirRel = relPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
  await ensureOnce(cfg, dirRel)

  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await davRequest(cfg, 'PUT', url, {
        body: buffer,
        headers: {
          'content-type': contentType,
          'content-length': String(buffer.length),
        },
      })
      if (OK_DAV.has(res.status)) return { ok: true, status: res.status, url, bytes: buffer.length }
      const text = await safeText(res)
      // 4xx（除 408/429）不重试
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { ok: false, status: res.status, url, error: `${res.status} ${text}` }
      }
      lastError = new Error(`${res.status} ${text}`)
    } catch (e) {
      lastError = e
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
  }
  return { ok: false, url, error: String(lastError?.message || lastError) }
}

/**
 * 把 HTTP 状态和异常翻译成"人话 + 怎么办"。
 * 面板会原样显示这两行，所以写具体一点：新手照着改就能通。
 */
function explainHttp(status, text) {
  const detail = String(text || '').slice(0, 200)
  if (status === 401 || status === 403) {
    return {
      message: `认证被拒（HTTP ${status}）${detail ? `：${detail}` : ''}`,
      hint: '用户名或密码不对。坚果云要用「应用密码」（网页版 → 账户信息 → 安全 → 第三方应用管理），不是登录密码；Nextcloud 用账号密码。改完密码要重启 DSH（环境变量只在启动时读取）。',
    }
  }
  if (status === 404) return { message: `服务端说路径不存在（HTTP 404）`, hint: '检查 webdav.url 是否写全：坚果云是 https://dav.jianguoyun.com/dav/ ；Nextcloud 是 https://域名/remote.php/dav/files/用户名/ 。' }
  if (status === 405) return { message: `服务端不接受这个操作（HTTP 405）`, hint: '这台服务器可能不是标准 WebDAV（有些网盘只给"共享链接"不是 DAV 端点）。' }
  if (status === 507) return { message: `服务端存储空间不足（HTTP 507）`, hint: '清理云端空间，或把 webdav.root 换到别的目录。' }
  if (status >= 500) return { message: `服务端出错（HTTP ${status}）${detail ? `：${detail}` : ''}`, hint: '一般是远端服务临时故障，过一会儿再测；持续失败就看服务商状态页。' }
  if (status === 301 || status === 302 || status === 307 || status === 308) {
    return { message: `被重定向（HTTP ${status}）`, hint: '把 webdav.url 换成重定向后的地址试试。' }
  }
  return { message: `HTTP ${status}${detail ? `：${detail}` : ''}`, hint: '对照服务商文档确认 DAV 地址与认证方式。' }
}

/**
 * Node 的 fetch 把真实原因藏在 `error.cause`（甚至 cause.errors）里，
 * 只读 e.message 永远只会看到 "fetch failed"。这里把整条链摊平再判断。
 */
function flattenError(e) {
  const seen = []
  const walk = (err, depth) => {
    if (!err || depth > 5 || seen.includes(err)) return
    seen.push(err)
    if (Array.isArray(err.errors)) for (const one of err.errors.slice(0, 4)) walk(one, depth + 1)
    if (err.cause) walk(err.cause, depth + 1)
  }
  walk(e, 0)
  return {
    codes: seen.map((x) => String(x?.code || '')).filter(Boolean).join(' '),
    text: seen.map((x) => String(x?.message || '')).filter(Boolean).join(' | ').slice(0, 400),
    name: String(e?.name || ''),
  }
}

function explainNetworkError(e) {
  const info = flattenError(e)
  const all = `${info.codes} ${info.text}`
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(all)) {
    return { message: '域名解析失败（ENOTFOUND）', hint: 'webdav.url 里的域名写错了，或这台机器没有网络 / DNS 被拦。' }
  }
  if (/ECONNREFUSED/i.test(all)) return { message: '连接被拒绝（ECONNREFUSED）', hint: '地址或端口不对：https 服务别写成 http；自建服务要确认端口和反向代理。' }
  if (/ECONNRESET|EPIPE/i.test(all)) return { message: '连接被重置（ECONNRESET）', hint: '可能是公司网络 / 代理拦了 WebDAV，或服务端要求 TLS 1.2+。' }
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(all)) {
    return { message: '证书 / 加密握手失败', hint: '自建服务用了自签证书；换受信任证书，或在服务端放行。' }
  }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|TimeoutError|abort/i.test(all) || info.name === 'AbortError') {
    return { message: '请求超时', hint: '网络慢或被墙。先把「单请求超时」调到 120000 再测。' }
  }
  if (/ENETUNREACH|EHOSTUNREACH/i.test(all)) return { message: '网络不可达（ENETUNREACH）', hint: '这台机器到不了那个地址：检查代理 / VPN / 防火墙。' }
  if (/UND_ERR_SOCKET|other side closed|socket hang up/i.test(all)) {
    return { message: '连接被对端中断（UND_ERR_SOCKET）', hint: '网盘/代理把连接掐了：稍等半分钟再试一次；反复出现就换网络或检查公司代理。' }
  }
  if (/bad port/i.test(all)) return { message: '端口不被允许', hint: '有些小号端口被 Node 的 fetch 直接拒绝（属于安全限制），换成标准端口或 8xxx 以上的端口。' }
  return { message: info.text.slice(0, 200) || String(e?.message || e), hint: '把这一行连同 log/archiver.log 的尾巴发给能看服务器的人。' }
}

/** 连通性自检：建根目录 + PROPFIND 一次，返回人能照着修的结论 */
export async function testWebdav(cfg) {
  const w = cfg?.webdav || {}

  if (!w.enabled) {
    return {
      ok: false,
      code: 'DISABLED',
      status: 0,
      base: '',
      message: 'WebDAV 上传没启用',
      hint: '在下面「WebDAV」分组里勾上「启用 WebDAV 上传」，填好地址 / 用户名 / 密码，再回来点测试。',
    }
  }
  if (!w.url) {
    return {
      ok: false,
      code: 'NO_URL',
      status: 0,
      base: '',
      message: '还没填服务地址（webdav.url）',
      hint: '坚果云：https://dav.jianguoyun.com/dav/ ｜ Nextcloud/ownCloud：https://你的域名/remote.php/dav/files/用户名/',
    }
  }
  if (w.username && !davPassword(cfg)) {
    return {
      ok: false,
      code: 'NO_PASSWORD',
      status: 0,
      base: '',
      message: '填了用户名，但没解析到密码',
      hint: `把密码填进「密码」，或设置环境变量 ${w.passwordEnv || 'DSH_ARCHIVER_WEBDAV_PASSWORD'} 后重启 DSH（环境变量只在启动时读）。`,
    }
  }

  let base = ''
  try {
    base = davBaseUrl(cfg)
  } catch (e) {
    return { ok: false, code: 'BAD_URL', status: 0, base: '', message: String(e?.message || e), hint: '地址要以 http:// 或 https:// 开头。' }
  }

  const attempt = async () => {
    const mk = await ensureCollection(cfg, '')
    const res = await davRequest(cfg, 'PROPFIND', `${base}/`, {
      headers: { depth: '0', 'content-type': 'application/xml; charset=utf-8' },
      body: '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    })
    const reachable = res.status === 207 || res.status === 200 || res.status === 405
    if (reachable) {
      return {
        ok: true,
        code: 'OK',
        status: res.status,
        base,
        created: mk.created.length,
        message: `WebDAV 可用（HTTP ${res.status}）`,
        hint: mk.created.length
          ? `远端根目录已建好：${base}（新建 ${mk.created.length} 级）。把「默认落地位置」设成「本地 + WebDAV」就会自动同步。`
          : `远端根目录已存在：${base}。把「默认落地位置」设成「本地 + WebDAV」就会自动同步。`,
      }
    }
    const text = await safeText(res)
    const ex = explainHttp(res.status, text)
    return { ok: false, code: `HTTP_${res.status}`, status: res.status, base, ...ex }
  }

  /** 网络级抖动（对端直接掐连接）在网盘上很常见：重试一次，别让用户对着偶发失败发愁 */
  const runOnce = async (tryIndex) => {
    try {
      return await attempt()
    } catch (e) {
      if (Number.isFinite(e?.status) && e.status > 0) {
        const ex = explainHttp(e.status, e.detail)
        return { ok: false, code: `HTTP_${e.status}`, status: e.status, base, ...ex }
      }
      if (tryIndex === 0) {
        await new Promise((r) => setTimeout(r, 800))
        return runOnce(1)
      }
      const ex = explainNetworkError(e)
      return { ok: false, code: String(e?.code || 'ERROR'), status: 0, base, ...ex }
    }
  }

  const result = await runOnce(0)
  if (!result.ok && result.status === 0 && result.code === 'UND_ERR_SOCKET') {
    return { ...result, hint: `${result.hint}（已自动重试过一次；连续失败通常是代理/防火墙掐连接或服务端限流，等半分钟再试）` }
  }
  return result
}
