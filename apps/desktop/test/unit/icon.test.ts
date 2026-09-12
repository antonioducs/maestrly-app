import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Validate generated Maestrly icon artifacts in production, beta and development channels (#447).
 * scripts/convert-icon.mjs produces the platform containers from the shared artwork.
 * These tests verify the structure of all three formats:
 * ICO headers, entries and embedded PNG data at every size;
 * ICNS magic and consistent declared length;
 * Linux hicolor PNGs from 16 to 512 pixels.
 * Regenerate with npm run icon, icon:beta or icon:dev.
 * Visual fidelity requires separate inspection; these tests validate container structure.
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function resPath(rel: string): string {
  return fileURLToPath(new URL(`../../resources/${rel}`, import.meta.url))
}

function parseIco(buf: Buffer): { count: number; sizes: number[] } {
  expect(buf.readUInt16LE(0)).toBe(0) // reserved
  expect(buf.readUInt16LE(2)).toBe(1) // type 1 = icon
  const count = buf.readUInt16LE(4)
  expect(count).toBeGreaterThan(0)
  const sizes: number[] = []
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16
    const w = buf.readUInt8(e) || 256 // 0 = 256
    const bpp = buf.readUInt16LE(e + 6)
    const len = buf.readUInt32LE(e + 8)
    const off = buf.readUInt32LE(e + 12)
    expect(bpp).toBe(32) // RGBA
    expect(len).toBeGreaterThan(0)
    expect(off + len).toBeLessThanOrEqual(buf.length) // Data remains within the file.
    // Each embedded Windows Vista-or-newer PNG entry starts with the PNG signature.
    expect(buf.subarray(off, off + 8).equals(PNG_SIG)).toBe(true)
    sizes.push(w)
  }
  return { count, sizes }
}

// Channel suffixes; production uses no suffix.
const CHANNELS: Array<{ name: string; suffix: string }> = [
  { name: 'prod', suffix: '' },
  { name: 'beta', suffix: '-beta' },
  { name: 'dev', suffix: '-dev' },
]
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]

describe('Maestrly icons have valid containers in all three channels', () => {
  for (const { name, suffix } of CHANNELS) {
    it(`${name}: icon${suffix}.ico = ICONDIR + 6 entries (16–256 px) with embedded PNG`, () => {
      const buf = readFileSync(resPath(`icon${suffix}.ico`))
      const { count, sizes } = parseIco(buf)
      expect(count).toBe(6)
      expect(sizes).toEqual([16, 32, 48, 64, 128, 256])
    })

    it(`${name}: icon${suffix}.icns has icns magic and a consistent length`, () => {
      const buf = readFileSync(resPath(`icon${suffix}.icns`))
      expect(buf.subarray(0, 4).toString('ascii')).toBe('icns')
      // The big-endian size at bytes 4 through 8 is the total file length.
      expect(buf.readUInt32BE(4)).toBe(buf.length)
    })

    it(`${name}: icons${suffix}/ (Linux hicolor) contains PNGs 16–512 px`, () => {
      for (const s of LINUX_SIZES) {
        const p = resPath(`icons${suffix}/${s}x${s}.png`)
        expect(existsSync(p), `${p} is missing`).toBe(true)
        const buf = readFileSync(p)
        expect(buf.subarray(0, 8).equals(PNG_SIG), `${p} is not PNG`).toBe(true)
      }
    })

    it(`${name}: icon${suffix}.png (1024 source) is a PNG`, () => {
      const buf = readFileSync(resPath(`icon${suffix}.png`))
      expect(buf.subarray(0, 8).equals(PNG_SIG)).toBe(true)
    })
  }
})
