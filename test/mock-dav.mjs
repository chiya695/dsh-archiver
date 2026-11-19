#!/usr/bin/env node
/**
 * test/mock-dav.mjs —— 一个只认 MKCOL / PUT / PROPFIND / HEAD 的假 WebDAV
 * ============================================================================
 * 用途：给人手工验证"设置页 → 测试 WebDAV"的成功路径，或给脚本当靶子。
 *
 *   node test/mock-dav.mjs            # 默认 127.0.0.1:8791，口令 user/pass
 *   node test/mock-dav.mjs 9000       # 换端口
 *
 * 然后在设置页把 webdav.url 填 http://127.0.0.1:8791/dav/ ，点「测试 WebDAV」，
 * 应当看到绿色横幅「WebDAV 自检通过」。
 * ============================================================================
 */
import http from 'node:http'

const port = Number(process.argv[2] || 8791)
const USER = process.env.MOCK_DAV_USER || 'user'
const PASS = process.env.MOCK_DAV_PASS || 'pass'
const AUTH = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`

const collections = new Set()
const files = new Map()

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)

    // 没有 Authorization 头也放行（面板第一次测试常常还没填用户名）
    if (req.headers.authorization && req.headers.authorization !== AUTH) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="mock"' })
      res.end('bad credentials')
      return
    }

    if (req.method === 'MKCOL') {
      if (collections.has(path)) { res.writeHead(405); res.end('exists'); return }
      collections.add(path)
      res.writeHead(201)
      res.end()
      return
    }
    if (req.method === 'PUT') {
      files.set(path, body)
      res.writeHead(201)
      res.end()
      return
    }
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' })
      res.end('<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href></d:response></d:multistatus>')
      return
    }
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }
    res.writeHead(405)
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock WebDAV 就绪：http://127.0.0.1:${port}/dav/ （口令 ${USER}/${PASS}，可省略认证）`)
})
