#!/usr/bin/env node
// Renders the app's icons, splash and notification icon from the Maestrly mark in src/ui/BrandMark.tsx, so they
// always match the mark the app draws. Run `npm run icons` after changing the mark; it needs Playwright's Chromium
// (`npx playwright install chromium`). The PNGs are committed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'assets', 'images')
const source = readFileSync(path.join(root, 'src', 'ui', 'BrandMark.tsx'), 'utf8')
const statement = /const M_PATH =([\s\S]*?)\n\n/.exec(source)?.[1]
if (!statement) throw new Error('M_PATH not found in BrandMark.tsx')
const M_PATH = [...statement.matchAll(/'([^']*)'/g)].map((match) => match[1]).join('')

const TILE = '#131514'
const INK = '#EDEAE3'
const BRASS = '#C9A86A'

/** The mark in its 966.4-unit box: the open ring and the M. */
const mark = (fg, ring) => `
  <path d="M 188.9 241.4 A 413.0 413.0 0 0 1 711.7 241.1" fill="none" stroke="${ring}" stroke-width="23.3" stroke-linecap="round"/>
  <path d="M 719.9 874.0 A 413.0 413.0 0 0 1 181.6 874.5" fill="none" stroke="${ring}" stroke-width="23.3" stroke-linecap="round"/>
  <g transform="translate(0,1120) scale(0.1,-0.1)" fill="${fg}" fill-rule="evenodd"><path d="${M_PATH}"/></g>`

/** A square image: an optional background (with rounded corners), and the mark at `scale` of its side, centered. */
function image({ size, background = null, radius = 0, scale, fg = INK, ring = BRASS }) {
  const inner = size * scale
  const offset = (size - inner) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${background ? `<rect width="${size}" height="${size}" rx="${radius}" fill="${background}"/>` : ''}
    <svg x="${offset}" y="${offset}" width="${inner}" height="${inner}" viewBox="-32.7 77.8 966.4 966.4">${mark(fg, ring)}</svg>
  </svg>`
}

const assets = {
  // iOS masks the corners itself and refuses transparency.
  'icon.png': image({ size: 1024, background: TILE, scale: 0.72 }),
  // Android adaptive icons keep their middle 66% visible under every mask.
  'adaptive-icon.png': image({ size: 1024, scale: 0.56 }),
  'monochrome-icon.png': image({ size: 1024, scale: 0.56, fg: '#FFFFFF', ring: '#FFFFFF' }),
  // The splash shows the mark as the app draws it, on the theme's canvas color.
  'splash-icon.png': image({ size: 512, background: TILE, radius: 128, scale: 0.8 }),
  // Android draws the notification icon as a silhouette in its status bar.
  'notification-icon.png': image({ size: 96, scale: 0.9, fg: '#FFFFFF', ring: '#FFFFFF' }),
  'favicon.png': image({ size: 64, background: TILE, radius: 14, scale: 0.8 }),
}

mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  for (const [name, svg] of Object.entries(assets)) {
    const size = Number(/width="(\d+)"/.exec(svg)[1])
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
    const png = await page.locator('svg').first().screenshot({ omitBackground: true })
    writeFileSync(path.join(out, name), png)
    console.log(`${name} ${size}x${size} (${png.length} bytes)`)
  }
} finally {
  await browser.close()
}
