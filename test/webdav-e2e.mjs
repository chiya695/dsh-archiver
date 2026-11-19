#!/usr/bin/env node
/**
 * test/webdav-e2e.mjs —— WebDAV 通路端到端自检
 * ============================================================================
 * 起一个只认 MKCOL / PUT / PROPFIND 的本地假 WebDAV，把 dest=both 真跑一遍：
 *   · MKCOL 逐级建目录被调用过；
 *   · 每个 zip 都 PUT 到位，且上传字节的 sha256 == 本地文件 sha256；
 *   · manifest.json 也上了远端；
 *   · Basic 认证头正确。
 *
 * 用法：node test/webdav-e2e.mjs
 * ============================================================================
 */
import http from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { loadCfg } from '../lib/config.mjs'
import { runArchive } from '../lib/run.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')

const store = new Map()      // path -> Buffer
const collections = new Set()
const log = []

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    log.push({ method: req.method, path, bytes: body.length, auth: req.headers.authorization || '' })
    if (req.method === 'MKCOL') {
      if (collections.has(path)) { res.writeHead(405); res.end('exists'); return }
      collections.add(path)
      res.writeHead(201); res.end()
      return
    }
    if (req.method === 'PUT') {
      store.set(path, body)
      res.writeHead(201); res.end()
      return
    }
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'content-type': 'application/xml' })
      res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>')
      return
    }
    res.writeHead(405); res.end()
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/dav/`

const tmp = mkdtempSync(join(tmpdir(), 'dsh-archiver-webdav-'))
const home = join(tmp, 'home')
const cfg = {
  ...loadCfg(home),
  dest: 'both',
  local: { root: join(tmp, 'out'), layout: 'flat', keepRuns: 3 },
  webdav: {
    enabled: true,
    url: base,
    username: 'user',
    password: 'pass',
    passwordEnv: '',
    root: 'dsh-archiver',
    timeoutMs: 15000,
  },
}

let failures = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failures++; console.log(`  ✗ ${msg}`) }
}

try {
  const report = await runArchive({ home, cfg, why: 'webdav-e2e' })
  ok(report.ok, `归档整体成功（${JSON.stringify(report.counts)}）`)
  ok(report.remote.uploaded === report.counts.packaged, `远端上传数 ${report.remote.uploaded} == 打包数 ${report.counts.packaged}`)
  ok(report.remote.failed.length === 0, '没有上传失败项')

  const mk = log.filter((l) => l.method === 'MKCOL')
  ok(mk.some((l) => l.path === '/dav/dsh-archiver'), '逐级 MKCOL 建过远端根目录')
  ok(mk.some((l) => l.path === '/dav/dsh-archiver/skills') || mk.some((l) => l.path === '/dav/dsh-archiver/plugins'), '建过 skills/ 或 plugins/ 子目录')

  const puts = log.filter((l) => l.method === 'PUT')
  ok(puts.length === report.counts.packaged + 1, `PUT 次数 ${puts.length} == 产物 + manifest`)
  ok(puts.every((l) => l.auth === `Basic ${Buffer.from('user:pass').toString('base64')}`), '每个 PUT 都带正确 Basic 认证')

  ok(store.has('/dav/dsh-archiver/manifest.json'), 'manifest.json 已上传')
  const manifest = JSON.parse(store.get('/dav/dsh-archiver/manifest.json').toString('utf8'))
  ok(manifest.tool === 'dsh-archiver' && manifest.dest === 'both', 'manifest 内容正确')

  let mismatch = 0
  for (const item of manifest.items) {
    // 服务端把 pathname 解码过，所以这里直接用原始相对路径拼
    const remotePath = `/dav/dsh-archiver/${item.relPath}`
    const remote = store.get(remotePath)
    if (!remote) { mismatch++; continue }
    if (sha(remote) !== item.sha256) mismatch++
  }
  ok(mismatch === 0, '每个远端 zip 的 sha256 与 manifest 一致')

  // 本地也真的写了
  const localOk = report.local.written === report.counts.packaged
  ok(localOk, `本地写入 ${report.local.written} 个`)
  ok(readFileSync(join(tmp, 'out', 'manifest.json')).length > 100, '本地 manifest.json 存在')

  // ── 自检结论的形状：面板要靠 message + hint 讲人话 ──
  const { testWebdav } = await import('../lib/webdav.mjs')

  const pass = await testWebdav(cfg)
  ok(pass.ok === true, `自检成功：${pass.message}`)
  ok(typeof pass.hint === 'string' && pass.hint.length > 10, '成功时也带一句"接下来干什么"')
  ok(pass.base.startsWith('http://127.0.0.1'), `base 是实际请求地址：${pass.base}`)

  const disabled = await testWebdav({ ...cfg, webdav: { ...cfg.webdav, enabled: false } })
  ok(disabled.ok === false && disabled.code === 'DISABLED', '没启用时的结论是 DISABLED 且带原因')

  const noUrl = await testWebdav({ ...cfg, webdav: { ...cfg.webdav, url: '' } })
  ok(noUrl.ok === false && noUrl.code === 'NO_URL' && /https:\/\//.test(noUrl.hint), '缺地址时 hint 里给了示例地址')

  // 401：临时起一个只回 401 的服务，确认被翻译成"认证被拒 + 怎么改"
  const denying = http.createServer((req, res) => { res.writeHead(401, { 'www-authenticate': 'Basic realm=x' }); res.end('nope') })
  await new Promise((r) => denying.listen(0, '127.0.0.1', r))
  try {
    const denied = await testWebdav({
      ...cfg,
      webdav: { ...cfg.webdav, url: `http://127.0.0.1:${denying.address().port}/dav/`, timeoutMs: 8000 },
    })
    ok(denied.ok === false && denied.status === 401, '401 被识别为认证失败')
    ok(/应用密码/.test(denied.hint || ''), '401 的 hint 提示了「应用密码」这种具体做法')
  } finally {
    denying.close()
  }
} finally {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nWebDAV 通路自检通过' : `\nWebDAV 通路自检失败 ${failures} 项`)
process.exitCode = failures === 0 ? 0 : 1
