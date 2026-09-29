/**
 * 生成应用图标：assets/icon.png（256）与 assets/icon.ico（多尺寸 PNG 容器）。
 * 纯 Node 绘制（无外部依赖）：蓝灰渐变圆角方块 + 白色时钟表盘 + 播放标记，
 * 与应用内品牌一致。超采样抗锯齿。
 */
import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba: Uint8Array, size: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------------------------------------------------------------- geometry
type Pt = [number, number]

function roundedRectSDF(px: number, py: number, size: number, radius: number): number {
  const qx = Math.abs(px) - (size / 2 - radius)
  const qy = Math.abs(py) - (size / 2 - radius)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius
}

function distToSegment(px: number, py: number, a: Pt, b: Pt): number {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((px - a[0]) * abx + (py - a[1]) * aby) / (abx * abx + aby * aby)))
  return Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby))
}

function pointInTriangle(px: number, py: number, a: Pt, b: Pt, c: Pt): boolean {
  const sign = (o: Pt, d: Pt, p: Pt) => (d[0] - o[0]) * (p[1] - o[1]) - (d[1] - o[1]) * (p[0] - o[0])
  const d1 = sign(a, b, [px, py])
  const d2 = sign(b, c, [px, py])
  const d3 = sign(c, a, [px, py])
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

const AA = 1.25 // 像素边缘平滑宽度（约 1px）

function renderIcon(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  // 渐变色（低饱和蓝，与 UI 品牌一致）
  const c1: [number, number, number] = [108, 140, 240] // #6C8CF0
  const c2: [number, number, number] = [58, 84, 190] // #3A54BE

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x - size / 2
      const cy = y - size / 2
      const u = x / size
      const v = y / size

      // 背景：圆角方块 + 对角渐变
      const bgSdf = roundedRectSDF(cx, cy, size * 0.94, size * 0.21)
      let a = Math.max(0, Math.min(1, 0.5 - bgSdf / AA))
      if (a <= 0) continue
      const t = Math.max(0, Math.min(1, (u + v) / 2))
      let r = c1[0] + (c2[0] - c1[0]) * t
      let g = c1[1] + (c2[1] - c1[1]) * t
      let b = c1[2] + (c2[2] - c1[2]) * t

      // 白色图层：时钟表盘（圆环 + 指针）+ 播放三角，统一 alpha 后覆盖
      const wa: Array<[number, number]> = []
      const hx = 0.44 * size - size / 2
      const hy = 0.42 * size - size / 2
      const ringR = 0.21 * size
      const ringW = 0.075 * size
      const ringDist = Math.abs(Math.hypot(cx - hx, cy - hy) - ringR)
      let white = Math.max(0, Math.min(1, 0.5 - (ringDist - ringW / 2) / AA))
      // 指针（12 点方向 + 3 点偏下方向）
      white = Math.max(
        white,
        Math.max(
          0,
          Math.min(1, 0.5 - (distToSegment(cx, cy, [hx, hy], [hx, hy - ringR * 0.85]) - ringW * 0.42) / AA)
        )
      )
      white = Math.max(
        white,
        Math.max(
          0,
          Math.min(1, 0.5 - (distToSegment(cx, cy, [hx, hy], [hx + ringR * 0.72, hy + ringR * 0.35]) - ringW * 0.42) / AA)
        )
      )
      // 播放三角（右下）
      const s = size
      const tri: [Pt, Pt, Pt] = [
        [0.615 * s - s / 2, 0.575 * s - s / 2],
        [0.615 * s - s / 2, 0.845 * s - s / 2],
        [0.855 * s - s / 2, 0.71 * s - s / 2]
      ]
      if (pointInTriangle(cx, cy, tri[0], tri[1], tri[2])) white = 1

      if (white > 0) {
        r = r + (255 - r) * white
        g = g + (255 - g) * white
        b = b + (255 - b) * white
      }

      const i = (y * size + x) * 4
      out[i] = Math.round(r)
      out[i + 1] = Math.round(g)
      out[i + 2] = Math.round(b)
      out[i + 3] = Math.round(a * 255)
    }
  }
  return out
}

/** 2x 超采样后缩小，平滑边缘 */
function renderSmooth(size: number): Uint8Array {
  const ss = renderIcon(size * 2)
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 4; c++) {
        const sum =
          ss[(y * 2 * size * 2 + x * 2) * 4 + c] +
          ss[(y * 2 * size * 2 + x * 2 + 1) * 4 + c] +
          ss[((y * 2 + 1) * size * 2 + x * 2) * 4 + c] +
          ss[((y * 2 + 1) * size * 2 + x * 2 + 1) * 4 + c]
        out[(y * size + x) * 4 + c] = Math.round(sum / 4)
      }
    }
  }
  return out
}

function buildIco(pngs: Array<{ size: number; data: Buffer }>): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries: Buffer[] = []
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + 16 * pngs.length
  pngs.forEach((p, i) => {
    const e = i * 16
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, e)
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1)
    dir.writeUInt8(0, e + 2)
    dir.writeUInt8(0, e + 3)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(p.data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    entries.push(p.data)
    offset += p.data.length
  })
  return Buffer.concat([header, dir, ...entries])
}

const outDir = path.resolve(process.cwd(), 'assets')
fs.mkdirSync(outDir, { recursive: true })

const sizes = [256, 48, 32, 16]
const pngs = sizes.map((size) => ({ size, data: encodePng(renderSmooth(size), size) }))
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(pngs))
fs.writeFileSync(path.join(outDir, 'icon.png'), encodePng(renderSmooth(256), 256))
console.log('assets/icon.ico + assets/icon.png generated')
