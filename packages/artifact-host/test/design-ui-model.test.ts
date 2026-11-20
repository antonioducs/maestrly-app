import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDesignManifest, parseTokensCssWithSpans } from '../src/design.js'
import type { ViewerDesign } from '../src/shell/contract.js'
import {
  arrangeScreens,
  clampInspectTag,
  describeDraftChanges,
  describeSuggestionChanges,
  fitAllCamera,
  fitScreenCamera,
  formatAutoSuggestionBody,
  formatChangeName,
  formatDisplayTokenValue,
  formatElementLabel,
  formatInspectStyles,
  formatTokenSummary,
  formatUsageSummary,
  inheritedTokenCount,
  normalizeColorHex,
  parseThemeSelector,
  rankVisibleScreens,
  SCREENS_GAP_X,
  SCREENS_GAP_Y,
  SCREENS_LABEL_ROOM,
  shouldHideScreenSize,
  splitTokenSummaryParts,
  stepNumericToken,
  themeDisplayName,
  tokensForTheme,
  tokenValuesEqual,
  viewportKindOf,
  wrapScreens,
  zoomAtCamera,
} from '../src/shell/design-ui-model.js'
import { format, type ShellKey } from '../src/shell/i18n.js'

const tEn = (key: ShellKey, vars?: Record<string, string | number>) => format('en', key, vars)
const tPt = (key: ShellKey, vars?: Record<string, string | number>) => format('pt-BR', key, vars)

function loadSampleDesign(): ViewerDesign {
  const sampleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/design-sample')
  const files = new Set(readdirSync(sampleDir))
  const manifest = parseDesignManifest(
    new Uint8Array(readFileSync(path.join(sampleDir, 'maestrly-design.json'))),
    files
  )
  if (!manifest) throw new Error('Expected valid design-sample manifest')
  const parsed = parseTokensCssWithSpans(readFileSync(path.join(sampleDir, manifest.tokens[0]!), 'utf8'))
  return {
    title: manifest.title ?? null,
    tokenFile: manifest.tokens[0]!,
    allTokenFiles: manifest.tokens,
    componentsPath: manifest.components ?? null,
    screens: manifest.screens,
    componentTokens: manifest.componentTokens ?? {},
    tokens: parsed.tokens,
    themes: parsed.themes,
  }
}

const SAMPLE_VIEWER_DESIGN = loadSampleDesign()

describe('screens layout and camera', () => {
  it('wraps screens into rows at rowMax with horizontal and vertical gaps', () => {
    const result = wrapScreens(SAMPLE_VIEWER_DESIGN.screens, 3200, SCREENS_GAP_Y)
    expect(result.placed).toHaveLength(6)
    // Two 1440px screens fit on row 0 (1440 + 160 + 1440 = 3040 <= 3200), third wraps to row 1.
    expect(result.placed[0]).toMatchObject({ x: 0, y: 0, width: 1440, height: 900, row: 0 })
    expect(result.placed[1]).toMatchObject({ x: 1440 + SCREENS_GAP_X, y: 0, row: 0 })
    expect(result.placed[2]).toMatchObject({ x: 0, y: 900 + SCREENS_GAP_Y, row: 1 })
    expect(result.width).toBe(3040)
  })

  it('picks wider rows on desktop and narrower rows on a phone while preserving label room', () => {
    const wide = arrangeScreens(SAMPLE_VIEWER_DESIGN.screens, { width: 1440, height: 848 })
    const narrow = arrangeScreens(SAMPLE_VIEWER_DESIGN.screens, { width: 390, height: 750 })
    expect(wide.rowMax).toBeGreaterThanOrEqual(3200)
    expect(narrow.rowMax).toBeLessThanOrEqual(wide.rowMax)
    // Vertical gap between rows always leaves at least SCREENS_LABEL_ROOM screen pixels at the fit zoom.
    const row1 = narrow.placed.find((item) => item.row === 1)
    const row0Height = Math.max(...narrow.placed.filter((item) => item.row === 0).map((item) => item.height))
    expect(row1).toBeDefined()
    expect((row1!.y - row0Height) * narrow.zoom).toBeGreaterThanOrEqual(SCREENS_LABEL_ROOM - 1)
  })

  it('fits all screens, focuses one screen, and zooms anchored at the pointer', () => {
    const box = { width: 1440, height: 848 }
    const layout = arrangeScreens(SAMPLE_VIEWER_DESIGN.screens, box)
    const allCam = fitAllCamera({ width: layout.width, height: layout.height }, box)
    expect(allCam.z).toBeGreaterThan(0.04)
    expect(allCam.z).toBeLessThanOrEqual(1)

    const focusCam = fitScreenCamera(layout.placed[0], box)
    expect(focusCam.z).toBeGreaterThan(allCam.z)

    // Zooming at pointer keeps the world coordinate under (px, py) invariant.
    const px = 420
    const py = 310
    const worldXBefore = (px - allCam.x) / allCam.z
    const worldYBefore = (py - allCam.y) / allCam.z
    const zoomed = zoomAtCamera(allCam, px, py, 1.5)
    expect((px - zoomed.x) / zoomed.z).toBeCloseTo(worldXBefore, 5)
    expect((py - zoomed.y) / zoomed.z).toBeCloseTo(worldYBefore, 5)
  })

  it('ranks visible screens nearest to the stage center first', () => {
    const box = { width: 1440, height: 848 }
    const layout = arrangeScreens(SAMPLE_VIEWER_DESIGN.screens, box)
    const focused = layout.placed[4]
    const cam = fitScreenCamera(focused, box)
    const visible = rankVisibleScreens(layout.placed, cam, box)
    expect(visible[0]).toBe(focused.screen.id)
  })

  it('hides screen dimensions before truncating the screen name (pre-approved label rule)', () => {
    // Wide desktop screen at 25% zoom -> 360px available; name (60) + gap (8) + size (68) = 136px fits.
    expect(shouldHideScreenSize(360, 60, 68)).toBe(false)
    // Narrow mobile screen (390px) at 25% zoom -> 97.5px available; name (84) + gap (8) + size (62) = 154px does not fit.
    expect(shouldHideScreenSize(97.5, 84, 62)).toBe(true)
    // Exact boundary fits.
    expect(shouldHideScreenSize(154, 84, 62)).toBe(false)
  })

  it('maps viewport presets and custom dimensions to viewer device kinds', () => {
    expect(viewportKindOf('desktop')).toBe('desktop')
    expect(viewportKindOf('tablet')).toBe('tablet')
    expect(viewportKindOf('mobile')).toBe('phone')
    expect(viewportKindOf({ width: 375, height: 812 })).toBe('phone')
    expect(viewportKindOf({ width: 900, height: 1200 })).toBe('tablet')
    expect(viewportKindOf({ width: 1280, height: 800 })).toBe('desktop')
  })
})

describe('themes, token formatting, and suggestions', () => {
  it('parses theme selectors and formats localized names', () => {
    expect(parseThemeSelector(null)).toEqual({ selector: null, name: '', system: false })
    expect(parseThemeSelector("[data-theme='dark']")).toEqual({
      selector: "[data-theme='dark']",
      name: 'dark',
      system: false,
    })
    expect(parseThemeSelector('.theme-high-contrast')).toEqual({
      selector: '.theme-high-contrast',
      name: 'high-contrast',
      system: false,
    })
    expect(parseThemeSelector('@media (prefers-color-scheme: dark)')).toEqual({
      selector: '@media (prefers-color-scheme: dark)',
      name: 'dark',
      system: true,
    })

    expect(themeDisplayName(tEn, null)).toBe('Default')
    expect(themeDisplayName(tPt, null)).toBe('Padrão')
    expect(themeDisplayName(tEn, "[data-theme='dark']")).toBe('Dark')
    expect(themeDisplayName(tEn, '@media (prefers-color-scheme: dark)')).toBe('Dark (system)')
    expect(themeDisplayName(tPt, '@media (prefers-color-scheme: dark)')).toBe('Dark (sistema)')
  })

  it('lists tokens per theme and computes inherited default counts', () => {
    const rootTokens = tokensForTheme(SAMPLE_VIEWER_DESIGN, null)
    const darkTokens = tokensForTheme(SAMPLE_VIEWER_DESIGN, "[data-theme='dark']")
    expect(rootTokens).toHaveLength(46)
    expect(darkTokens).toHaveLength(18)
    expect(inheritedTokenCount(SAMPLE_VIEWER_DESIGN, null)).toBe(0)
    expect(inheritedTokenCount(SAMPLE_VIEWER_DESIGN, "[data-theme='dark']")).toBe(28)
  })

  it('normalizes opaque colors and compares equivalent representations', () => {
    expect(normalizeColorHex('#fff')).toBe('#FFFFFF')
    expect(normalizeColorHex('#b4532a')).toBe('#B4532A')
    expect(normalizeColorHex('rgb(180, 83, 42)')).toBe('#B4532A')
    expect(normalizeColorHex('rgba(31, 26, 21, 0.1)')).toBeNull()
    expect(tokenValuesEqual('color', '#b4532a', '#B4532A')).toBe(true)
    expect(tokenValuesEqual('color', 'rgb(180, 83, 42)', '#B4532A')).toBe(true)
    expect(formatDisplayTokenValue('#b4532a', 'color')).toBe('#B4532A')
    expect(formatDisplayTokenValue('10px', 'length')).toBe('10px')
  })

  it('describes draft changes and detects stale suggestions', () => {
    const drafts = describeDraftChanges(SAMPLE_VIEWER_DESIGN, [
      { name: '--color-accent', value: '#0f766e', theme: null },
      { name: '--color-accent', value: '#2db5a6', theme: "[data-theme='dark']" },
      { name: '--radius-md', value: '14px', theme: null },
    ])
    expect(drafts.map((c) => formatChangeName(tEn, c.name, c.theme))).toEqual([
      '--color-accent',
      '--color-accent (Dark)',
      '--radius-md',
    ])
    expect(formatTokenSummary(tEn, drafts)).toBe('Tokens: --color-accent, --color-accent (Dark), --radius-md')
    expect(formatTokenSummary(tEn, drafts, 'Marina Souza')).toBe(
      'Tokens suggested by Marina Souza: --color-accent, --color-accent (Dark), --radius-md'
    )
    expect(formatAutoSuggestionBody(tEn, drafts)).toBe(
      'Tokens: --color-accent #B4532A → #0F766E, --color-accent (Dark) #E07A4B → #2DB5A6, --radius-md 10px → 14px'
    )

    const suggestionChanges = describeSuggestionChanges(SAMPLE_VIEWER_DESIGN, [
      { name: '--color-accent', from: '#b4532a', to: '#0f766e' },
      { name: '--radius-md', from: '8px', to: '14px' },
    ])
    expect(suggestionChanges[0].stale).toBe(false)
    expect(suggestionChanges[1]).toMatchObject({ now: '10px', stale: true })
  })

  it('steps numeric and length tokens with precision and Shift multiplier', () => {
    expect(stepNumericToken('10px', 1, false)).toBe('11px')
    expect(stepNumericToken('10px', -1, true)).toBe('0px')
    expect(stepNumericToken('1.2', 1, false)).toBe('1.3')
    expect(stepNumericToken('500', 1, false)).toBe('550')
    expect(stepNumericToken('120ms', 1, true)).toBe('130ms')
    expect(stepNumericToken('auto', 1, false)).toBeNull()
  })

  it('splits summary text so CSS custom properties stay non-wrapping', () => {
    expect(splitTokenSummaryParts('Summary: Tokens: --color-accent, --radius-md')).toEqual([
      { text: 'Summary: Tokens: ', nowrap: false },
      { text: '--color-accent', nowrap: true },
      { text: ', ', nowrap: false },
      { text: '--radius-md', nowrap: true },
    ])
  })
})

describe('inspect formatting', () => {
  it('derives readable element labels from selector and tag', () => {
    expect(formatElementLabel({ tag: 'H2', selector: 'main > section:nth-of-type(2) > h2.section-title' })).toBe(
      'h2.section-title'
    )
    expect(formatElementLabel({ tag: 'BUTTON', selector: 'div > button.primary:nth-of-type(1)' })).toBe(
      'button.primary'
    )
    expect(formatElementLabel({ tag: 'DIV', selector: '' })).toBe('div')
    expect(formatElementLabel({ tag: 'H2', selector: 'main > h2:nth-of-type(1)', elementLabel: 'h2.dish' })).toBe(
      'h2.dish'
    )
  })

  it('places inspect tags above, below, or inside the box within frame bounds', () => {
    const bounds = { width: 800, height: 600 }
    // Room above -> 24px above box.
    expect(clampInspectTag({ x: 100, y: 80, width: 120, height: 40 }, 90, bounds)).toEqual({ x: 100, y: 56 })
    // Too close to top -> below box.
    expect(clampInspectTag({ x: 100, y: 10, width: 120, height: 40 }, 90, bounds)).toEqual({ x: 100, y: 54 })
    // Fills frame height -> inside top-left.
    expect(clampInspectTag({ x: 750, y: 2, width: 48, height: 590 }, 90, bounds)).toEqual({ x: 706, y: 6 })
  })

  it('formats computed styles and usage summaries', () => {
    const rows = formatInspectStyles(
      {
        rect: { x: 0, y: 0, width: 112.4, height: 36.6 },
        styles: {
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: '13px',
          fontWeight: '600',
          lineHeight: '20px',
          color: 'rgb(255, 255, 255)',
          backgroundColor: '#b4532a',
          borderRadius: '10px',
          padding: '8px 16px',
        },
      },
      tEn
    )
    expect(rows).toEqual([
      { label: 'Font', value: 'Inter · 600', swatch: false },
      { label: 'Size', value: '13px / 20px', swatch: false },
      { label: 'Color', value: '#FFFFFF', swatch: true },
      { label: 'Background', value: '#B4532A', swatch: true },
      { label: 'Radius', value: '10px', swatch: false },
      { label: 'Padding', value: '8px 16px', swatch: false },
      { label: 'Box', value: '112 × 37', swatch: false },
    ])

    expect(formatUsageSummary(tEn, 4, 2, 3, 6)).toBe('4 so far · 3 of 6 screens measured')
    expect(formatUsageSummary(tEn, 0, 0, 6, 6)).toBe('Not used on any screen.')
    expect(formatUsageSummary(tEn, 1, 1, 6, 6)).toBe('1 instance on 1 screen')
    expect(formatUsageSummary(tEn, 5, 1, 6, 6)).toBe('5 instances on 1 screen')
    expect(formatUsageSummary(tEn, 18, 6, 6, 6)).toBe('18 instances on 6 screens')
  })
})
