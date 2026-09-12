import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildIco } from './icon-encoders.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RES = path.resolve(__dirname, '..', 'apps', 'desktop', 'resources')
const SRC = process.env.MAESTRLY_ICON_SOURCE || path.join(RES, 'icon.png')

const CHANNELS = ['prod', 'beta', 'dev']
const arg = process.argv[2]
const targets = !arg || arg === 'all' ? CHANNELS : [arg]
for (const c of targets) {
  if (!CHANNELS.includes(c)) {
    console.error(`convert-icon: invalid channel "${c}". Use: ${CHANNELS.join(' | ')} | all`)
    process.exit(1)
  }
}

const ICO_SIZES = [16, 32, 48, 64, 128, 256] // Windows
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]
const ICNS_SIZES = [
  [16, '16x16'],
  [32, '16x16@2x'],
  [32, '32x32'],
  [64, '32x32@2x'],
  [128, '128x128'],
  [256, '128x128@2x'],
  [256, '256x256'],
  [512, '256x256@2x'],
  [512, '512x512'],
  [1024, '512x512@2x'],
]

function sipsResize(src, px, out) {
  execFileSync('sips', ['-z', String(px), String(px), src, '--out', out], { stdio: 'ignore' })
}

async function genChannel(channel) {
  const suffix = channel === 'prod' ? '' : `-${channel}`
  const tmp = path.join(os.tmpdir(), `maestrly-icon${suffix}-${process.pid}`)
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })

  if (path.resolve(SRC) !== path.join(RES, `icon${suffix}.png`)) {
    await fs.copyFile(SRC, path.join(RES, `icon${suffix}.png`))
  }

  // 2) Linux — resources/icons{suffix}/{n}x{n}.png (hicolor 16–512)
  const linuxDir = path.join(RES, `icons${suffix}`)
  await fs.rm(linuxDir, { recursive: true, force: true })
  await fs.mkdir(linuxDir, { recursive: true })
  for (const s of LINUX_SIZES) sipsResize(SRC, s, path.join(linuxDir, `${s}x${s}.png`))

  const images = []
  for (const s of ICO_SIZES) {
    const p = path.join(tmp, `ico-${s}.png`)
    sipsResize(SRC, s, p)
    images.push({ size: s, png: await fs.readFile(p) })
  }
  await fs.writeFile(path.join(RES, `icon${suffix}.ico`), buildIco(images))

  // 4) .icns (macOS) — iconset (sips) → iconutil
  const iconset = path.join(tmp, `icon${suffix}.iconset`)
  await fs.mkdir(iconset, { recursive: true })
  for (const [px, name] of ICNS_SIZES) sipsResize(SRC, px, path.join(iconset, `icon_${name}.png`))
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(RES, `icon${suffix}.icns`)])

  await fs.rm(tmp, { recursive: true, force: true })
  console.log(`✓ ${channel}: resources/icon${suffix}.{png,ico,icns} + icons${suffix}/`)
}

async function main() {
  try {
    await fs.access(SRC)
  } catch {
    console.error(`convert-icon: source not found: ${SRC}\nSet MAESTRLY_ICON_SOURCE to a source PNG.`)
    process.exit(1)
  }
  if (process.platform !== 'darwin') {
    console.error('convert-icon: requires macOS (sips/iconutil). Generated icons are committed; run this on a Mac.')
    process.exit(1)
  }
  await fs.mkdir(RES, { recursive: true })
  for (const c of targets) await genChannel(c)
  console.log(`✓ Maestrly icons generated (${targets.join(', ')}) — shared artwork across channels.`)
}

main().catch((e) => {
  console.error('convert-icon failed:', e)
  process.exit(1)
})
