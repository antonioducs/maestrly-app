import zlib from 'node:zlib'

// ---------- CRC32 (cached table) ----------
let CRC
function crc32(buf) {
  if (!CRC) {
    CRC = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

export function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth 8
  ihdr[9] = 6 // color type 6 (RGBA)
  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filtro None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// Decodes a non-interlaced 8-bit RGB/RGBA PNG into an RGBA buffer ({ rgba, width, height }).
export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('decodePng: not a PNG')
  let pos = 8
  let width = 0,
    height = 0,
    colorType = 0,
    bitDepth = 0,
    interlace = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    pos += 12 + len
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0)
    throw new Error(`decodePng: unsupported PNG (depth=${bitDepth} color=${colorType} interlace=${interlace})`)
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const rgba = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let off = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[off++]
    const line = Buffer.from(raw.subarray(off, off + stride))
    off += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a),
          pb = Math.abs(p - b),
          pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[x] = v & 255
    }
    for (let x = 0; x < width; x++) {
      const s = x * bpp,
        d = (y * width + x) * 4
      rgba[d] = line[s]
      rgba[d + 1] = line[s + 1]
      rgba[d + 2] = line[s + 2]
      rgba[d + 3] = bpp === 4 ? line[s + 3] : 255
    }
    prev = line
  }
  return { rgba, width, height }
}

// Builds a macOS menu-bar "template" image from the app icon: template images only use
// the alpha channel, so the light glyph becomes opaque black and the dark background
// becomes transparent (instead of rendering as a solid rounded square).
export function toTemplateMask(rgba, size) {
  const out = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    const lum = (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000
    const a = rgba[o + 3] / 255
    // luminance ramp: <64 → transparent, >192 → opaque; keeps anti-aliasing on the glyph edge
    const k = Math.min(1, Math.max(0, (lum - 64) / 128))
    out[o + 3] = Math.round(k * a * 255)
  }
  return out
}

// Crops a square RGBA image to the bounding box of its visible pixels (alpha > threshold),
// keeping it square (centered) and adding `padRatio` of the content size as margin.
export function cropToContent(rgba, size, padRatio = 0.08, threshold = 24) {
  let minX = size, minY = size, maxX = -1, maxY = -1
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      if (rgba[(y * size + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  if (maxX < 0) return { rgba, size }
  const cw = maxX - minX + 1, ch = maxY - minY + 1
  const content = Math.max(cw, ch)
  const out = Math.round(content * (1 + padRatio * 2))
  const cx = minX + cw / 2, cy = minY + ch / 2
  const ox = Math.round(cx - out / 2), oy = Math.round(cy - out / 2)
  const dst = Buffer.alloc(out * out * 4)
  for (let y = 0; y < out; y++) {
    const sy = oy + y
    if (sy < 0 || sy >= size) continue
    for (let x = 0; x < out; x++) {
      const sx = ox + x
      if (sx < 0 || sx >= size) continue
      rgba.copy(dst, (y * out + x) * 4, (sy * size + sx) * 4, (sy * size + sx) * 4 + 4)
    }
  }
  return { rgba: dst, size: out }
}

export function downsample(src, srcSize, dstSize) {
  if (dstSize === srcSize) return src
  const dst = Buffer.alloc(dstSize * dstSize * 4)
  const ratio = srcSize / dstSize
  for (let dy = 0; dy < dstSize; dy++) {
    const sy0 = Math.floor(dy * ratio),
      sy1 = Math.max(sy0 + 1, Math.min(srcSize, Math.floor((dy + 1) * ratio)))
    for (let dx = 0; dx < dstSize; dx++) {
      const sx0 = Math.floor(dx * ratio),
        sx1 = Math.max(sx0 + 1, Math.min(srcSize, Math.floor((dx + 1) * ratio)))
      let R = 0,
        G = 0,
        B = 0,
        A = 0,
        n = 0
      for (let sy = sy0; sy < sy1; sy++)
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * srcSize + sx) * 4
          const a = src[o + 3] / 255
          R += src[o] * a
          G += src[o + 1] * a
          B += src[o + 2] * a
          A += a
          n++
        }
      const o = (dy * dstSize + dx) * 4
      if (A > 0) {
        dst[o] = Math.round(R / A)
        dst[o + 1] = Math.round(G / A)
        dst[o + 2] = Math.round(B / A)
        dst[o + 3] = Math.round((A / n) * 255)
      }
    }
  }
  return dst
}

// ---------- container ICO (ICONDIR + ICONDIRENTRY[] + embedded PNGs) ----------

export function buildIco(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type 1 = icon
  header.writeUInt16LE(count, 4)
  const entries = Buffer.alloc(16 * count)
  const blobs = []
  let offset = 6 + 16 * count
  images.forEach((img, i) => {
    const e = entries.subarray(i * 16, i * 16 + 16)
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0) // width  (0 = 256)
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1) // height (0 = 256)
    e.writeUInt8(0, 2) // palette (0 = truecolor)
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel (RGBA)
    e.writeUInt32LE(img.png.length, 8) // tamanho do dado
    e.writeUInt32LE(offset, 12) // offset do dado
    offset += img.png.length
    blobs.push(img.png)
  })
  return Buffer.concat([header, entries, ...blobs])
}
