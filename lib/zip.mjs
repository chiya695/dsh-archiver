/**
 * lib/zip.mjs —— 零依赖 ZIP 写入器
 * ============================================================================
 * 为什么自己写：
 *   · 插件是 link 到 profile 里的本地包，裸 import `fflate` 会依赖 profile 树里
 *     恰好 hoist 了它（这次有，下次未必）；
 *   · 只要满足「能被系统资源管理器 / 7-Zip / Expand-Archive 正常解开」，
 *     一个 deflate + 中央目录就够了，不需要流式、加密、Zip64。
 *
 * 实现要点：
 *   · 文件名走 UTF-8（通用标志位 bit 11）；
 *   · 目录项不单独写（解压时按路径自动建目录），但空目录会丢 —— 无害；
 *   · 压缩后反而变大时退回 store（method 0）；
 *   · 时间戳用本地时间转 MS-DOS 时间，解压出来跟源文件对得上。
 * ============================================================================
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** 标准 CRC-32（IEEE 802.3） */
export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosDateTime(input) {
  const d = input instanceof Date ? input : new Date(input || Date.now())
  const year = Math.max(1980, d.getFullYear())
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
  }
}

function normalizeName(name) {
  return String(name).replace(/\\/g, '/').replace(/^\/+/, '')
}

/** ZIP 的条目数字段是 16 位；本实现不写 Zip64，所以超过 65535 必须明确报错 */
const MAX_ZIP_ENTRIES = 65535

/**
 * 打包。
 * @param {Array<{name:string, data:Buffer|Uint8Array, mtime?:Date|number}>} entries
 * @param {{level?:number}} [options]
 * @returns {Buffer} 完整 zip 字节
 */
export function buildZip(entries, options = {}) {
  const level = Math.round(Math.min(9, Math.max(0, Number.isFinite(options.level) ? options.level : 6)))
  const list = [...(entries || [])]
    .map((e) => ({ name: normalizeName(e.name), data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? []), mtime: e.mtime }))
    .filter((e) => e.name)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  if (list.length > MAX_ZIP_ENTRIES) {
    throw new Error(`文件太多（${list.length} 个），单个 zip 最多 ${MAX_ZIP_ENTRIES} 个条目；请把 zip.exclude 加上大目录，或把 maxFileMB 调小`)
  }

  const localChunks = []
  const centralChunks = []
  let offset = 0

  for (const entry of list) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    const crc = crc32(data)
    let body = data
    let method = 0
    if (level > 0 && data.length > 0) {
      const deflated = deflateRawSync(data, { level })
      if (deflated.length < data.length) {
        body = deflated
        method = 8
      }
    }
    const { date, time } = dosDateTime(entry.mtime)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0x0800, 6)      // flags: UTF-8 名字
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    localChunks.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)    // made by: unix, 3.0
    central.writeUInt16LE(20, 6)        // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)        // extra len
    central.writeUInt16LE(0, 32)        // comment len
    central.writeUInt16LE(0, 34)        // disk start
    central.writeUInt16LE(0, 36)        // internal attrs
    // external attrs：rw-r--r--（0o100644 << 16 在 JS 里会被当成有符号 int32，必须先 >>> 0）
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)

    centralChunks.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, centralBuf, eocd])
}

/**
 * 读回 zip（自检 / 校验用）。只支持本文件写出来的形态：无加密、无 Zip64。
 * @param {Buffer} buf
 * @returns {Array<{name:string, size:number, crc:number, data:Buffer}>}
 */
export function readZip(buf) {
  const eocdAt = findEocd(buf)
  if (eocdAt < 0) throw new Error('不是有效的 zip：找不到中央目录结束记录')
  const total = buf.readUInt16LE(eocdAt + 10)
  let at = buf.readUInt32LE(eocdAt + 16)
  const out = []
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`中央目录第 ${i} 项签名不对`)
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
    const compSize = buf.readUInt32LE(at + 20)
    const size = buf.readUInt32LE(at + 24)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)

    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`本地头签名不对：${name}`)
    const localNameLen = buf.readUInt16LE(localAt + 26)
    const localExtraLen = buf.readUInt16LE(localAt + 28)
    const dataAt = localAt + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataAt, dataAt + compSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (data.length !== size) throw new Error(`长度不符：${name}`)
    if (crc32(data) !== crc) throw new Error(`CRC 不符：${name}`)
    out.push({ name, size, crc, data })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 0x10000 - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}
