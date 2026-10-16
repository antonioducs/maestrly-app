#!/usr/bin/env node
// Renders the app's icons and notification icon from the Maestrly mark in src/ui/brand.ts, so they always match the
// mark the app draws. Run `npm run icons` after changing the mark; it needs Playwright's Chromium
// (`npx playwright install chromium`). The PNGs are committed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, 'assets', 'images')
const source = readFileSync(path.join(root, 'src', 'ui', 'brand.ts'), 'utf8')
/** A string constant of brand.ts, whose long paths are split into concatenated literals. */
function constant(name) {
  const statement = new RegExp(`export const ${name} =\\s*((?:'[^']*'\\s*\\+\\s*)*'[^']*')`).exec(source)?.[1]
  if (!statement) throw new Error(`${name} not found in brand.ts`)
  return [...statement.matchAll(/'([^']*)'/g)].map((match) => match[1]).join('')
}
const TOP_ARC = constant('TOP_ARC')
const BOTTOM_ARC = constant('BOTTOM_ARC')
const M_PATH = constant('M_PATH')
const LEFT_FOOT = constant('LEFT_FOOT')
const RIGHT_FOOT = constant('RIGHT_FOOT')

const TILE = '#131514'
const INK = '#EDEAE3'
const BRASS = '#C9A86A'

/** The mark in its 966.4-unit box: the open ring, the M and its feet. */
const mark = (fg, ring) => `
  <path d="${TOP_ARC}" fill="none" stroke="${ring}" stroke-width="23.3" stroke-linecap="round"/>
  <path d="${BOTTOM_ARC}" fill="none" stroke="${ring}" stroke-width="23.3" stroke-linecap="round"/>
  <g transform="translate(0,1120) scale(0.1,-0.1)" fill="${fg}" fill-rule="evenodd">
    <path d="${M_PATH}"/><path d="${LEFT_FOOT}"/><path d="${RIGHT_FOOT}"/>
  </g>`

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
  // The native splash is only its background color: the intro (src/ui/Intro.tsx) draws the logo over it. Android's
  // splash always shows an image, so this one is transparent.
  'splash-icon.png': `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"></svg>`,
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
