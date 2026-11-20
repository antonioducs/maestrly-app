import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createArtifactAdmin } from '../src/admin.js'
import {
  buildTokenEdits,
  createDesignService,
  DesignActionError,
  formatTokenSummary,
  parseDesignManifest,
  parseTokensCssWithSpans,
} from '../src/design.js'
import { applyEdits } from '../src/edits.js'
import { isValidThemeSelector, isValidTokenName, isValidTokenValue } from '../src/shell/contract.js'
import { tokenDraftKey } from '../src/shell/design-model.js'
import { ArtifactStore } from '../src/store/artifact-store.js'
import { BlobStore } from '../src/store/blobs.js'
import { openDatabase } from '../src/store/db.js'
import { tempDir, testClock, text, utf8 } from './helpers.js'

describe('parseDesignManifest', () => {
  const bundle = new Set(['index.html', 'tokens.css', 'styles/extra.css', 'components.html', 'screens/checkout.html'])

  it('parses valid manifests with optional title, presets, custom viewports, query/hash paths, and componentTokens', () => {
    const noTitle = parseDesignManifest(
      utf8(
        JSON.stringify({
          schema: 'maestrly-prototype/v1',
          tokens: ['tokens.css', 'styles/extra.css'],
          screens: [
            { id: 'home', name: 'Home', path: 'index.html#/home', viewport: 'desktop' },
            {
              id: 'checkout',
              name: 'Checkout',
              path: 'screens/checkout.html?step=2#pay',
              viewport: { width: 320, height: 2560 },
            },
          ],
        })
      ),
      bundle
    )
    expect(noTitle).toEqual({
      schema: 'maestrly-prototype/v1',
      tokens: ['tokens.css', 'styles/extra.css'],
      screens: [
        { id: 'home', name: 'Home', path: 'index.html#/home', viewport: 'desktop' },
        {
          id: 'checkout',
          name: 'Checkout',
          path: 'screens/checkout.html?step=2#pay',
          viewport: { width: 320, height: 2560 },
        },
      ],
    })

    const full = parseDesignManifest(
      utf8(
        JSON.stringify({
          schema: 'maestrly-prototype/v1',
          title: '  Checkout v2  ',
          tokens: ['tokens.css'],
          components: 'components.html',
          screens: [{ id: 'home', name: 'Home', path: 'index.html', viewport: 'desktop' }],
          componentTokens: {
            ButtonPrimary: ['--btn-bg', '--btn-fg'],
          },
        })
      ),
      bundle
    )
    expect(full).toEqual({
      schema: 'maestrly-prototype/v1',
      title: 'Checkout v2',
      tokens: ['tokens.css'],
      components: 'components.html',
      screens: [{ id: 'home', name: 'Home', path: 'index.html', viewport: 'desktop' }],
      componentTokens: { ButtonPrimary: ['--btn-bg', '--btn-fg'] },
    })
  })

  it('rejects invalid schema, missing files, path traversal, out-of-range viewports, duplicate screen IDs, and oversized manifests', () => {
    const validScreens = [{ id: 's1', name: 'S1', path: 'index.html', viewport: 'desktop' }]
    const check = (obj: unknown) => parseDesignManifest(utf8(JSON.stringify(obj)), bundle)
    expect(check({ schema: 'maestrly-prototype/v2', tokens: ['tokens.css'], screens: validScreens })).toBeNull()
    expect(check({ schema: 1, tokens: ['tokens.css'], screens: validScreens })).toBeNull()
    expect(check({ schema: 'maestrly-prototype/v1', tokens: [], screens: validScreens })).toBeNull()
    expect(check({ schema: 'maestrly-prototype/v1', tokens: ['tokens.css'], screens: [] })).toBeNull()
    expect(check({ schema: 'maestrly-prototype/v1', tokens: ['missing.css'], screens: validScreens })).toBeNull()
    expect(check({ schema: 'maestrly-prototype/v1', tokens: ['index.html'], screens: validScreens })).toBeNull()
    expect(check({ schema: 'maestrly-prototype/v1', tokens: ['../tokens.css'], screens: validScreens })).toBeNull()
    expect(
      check({
        schema: 'maestrly-prototype/v1',
        tokens: ['tokens.css'],
        components: 'missing.html',
        screens: validScreens,
      })
    ).toBeNull()
    expect(
      check({
        schema: 'maestrly-prototype/v1',
        tokens: ['tokens.css'],
        components: 'tokens.css',
        screens: validScreens,
      })
    ).toBeNull()
    expect(
      check({ schema: 'maestrly-prototype/v1', title: 'Bad\nTitle', tokens: ['tokens.css'], screens: validScreens })
    ).toBeNull()
    expect(
      check({ schema: 'maestrly-prototype/v1', tokens: ['tokens.css'], screens: validScreens, extraField: true })
    ).toBeNull()
    expect(
      check({
        schema: 'maestrly-prototype/v1',
        tokens: ['tokens.css'],
        screens: [{ id: 's1', name: 'S1', path: 'index.html', viewport: { width: 319, height: 800 } }],
      })
    ).toBeNull()
    expect(
      check({
        schema: 'maestrly-prototype/v1',
        tokens: ['tokens.css'],
        screens: [{ id: 's1', name: 'S1', path: 'index.html', viewport: { width: 800, height: 2561 } }],
      })
    ).toBeNull()
    expect(
      check({
        schema: 'maestrly-prototype/v1',
        tokens: ['tokens.css'],
        screens: [
          { id: 'dup', name: 'One', path: 'index.html', viewport: 'mobile' },
          { id: 'dup', name: 'Two', path: 'index.html', viewport: 'tablet' },
        ],
      })
    ).toBeNull()
    expect(
      check({
        schema: 'maestrly-prototype/v1',
        tokens: ['tokens.css'],
        screens: [{ id: 'missing', name: 'Missing', path: 'nope.html#x', viewport: 'mobile' }],
      })
    ).toBeNull()
    expect(
      check({
        schema: 'maestrly-prototype/v1',
        tokens: ['tokens.css'],
        screens: validScreens,
        componentTokens: { lowercaseBad: ['--btn-bg'] },
      })
    ).toBeNull()

    // > 64 KiB rejected before parsing
    expect(parseDesignManifest(new Uint8Array(65 * 1024), bundle)).toBeNull()

    // 51 screens rejected, 50 screens accepted
    const fifty = Array.from({ length: 50 }, (_, i) => ({
      id: `s-${i}`,
      name: `Screen ${i}`,
      path: 'index.html',
      viewport: 'desktop' as const,
    }))
    expect(check({ schema: 'maestrly-prototype/v1', tokens: ['tokens.css'], screens: fifty })?.screens).toHaveLength(50)
    expect(
      check({
        schema: 'maestrly-prototype/v1',
        tokens: ['tokens.css'],
        screens: [...fifty, { id: 's-50', name: 'Too many', path: 'index.html', viewport: 'desktop' }],
      })
    ).toBeNull()
  })
})

describe('token value & selector security validators', () => {
  it('accepts safe CSS token values and rejects injection / network primitives', () => {
    for (const good of [
      '#0f172a',
      'rgb(15 23 42 / 0.8)',
      'oklch(0.62 0.19 255)',
      'clamp(1rem, 2vw + 0.5rem, 2.25rem)',
      'calc(var(--space-4) * 2)',
      '"Geist Sans", system-ui, -apple-system, sans-serif',
      '0 12px 32px -8px rgba(0, 0, 0, 0.32)',
      'cubic-bezier(0.2, 0, 0, 1)',
    ]) {
      expect(isValidTokenValue(good), good).toBe(true)
    }

    for (const bad of [
      '',
      '   ',
      'x'.repeat(201),
      '#fff; background: red',
      '#fff } body { display: none',
      '#fff {',
      '\\65 rl(https://evil.example)',
      '#fff\n#000',
      '#fff /* comment */',
      'url(https://evil.example/leak.png)',
      'URL("data:image/svg+xml,...")',
      'linear-gradient(red, url(foo.png))',
      'image-set("a.png" 1x)',
      '-webkit-image-set("a.png" 1x)',
      'expression(alert(1))',
      '@import "evil.css"',
    ]) {
      expect(isValidTokenValue(bad), bad).toBe(false)
    }

    expect(isValidTokenName('--color-brand')).toBe(true)
    expect(isValidTokenName('color-brand')).toBe(false)
    expect(isValidTokenName('--' + 'a'.repeat(63))).toBe(false)

    expect(isValidThemeSelector('[data-theme="dark"]')).toBe(true)
    expect(isValidThemeSelector('.dark')).toBe(true)
    expect(isValidThemeSelector('@media (prefers-color-scheme: dark)')).toBe(true)
    expect(isValidThemeSelector('body > *')).toBe(false)
  })
})

describe('parseTokensCssWithSpans & buildTokenEdits', () => {
  it('scans comments, themes, @layer, @media, duplicates (last-wins), !important, and exact value spans', () => {
    const css = [
      '/* Header comment: --ignored-comment: #ff0000; */',
      '@layer tokens {',
      '  :root, :host {',
      '    /* overridden below */',
      '    --color-brand: #111111;',
      '    --space-md: /* inline */ 16px !important ;',
      '    --font-sans: "Inter; Bold", system-ui;',
      '    --color-brand: #2563eb;',
      '  }',
      '}',
      '[data-theme="dark"] {',
      '  --color-brand: #60a5fa;',
      '  --theme-only-orphan: #999999;',
      '}',
      '@media (prefers-color-scheme: dark) {',
      '  :root {',
      '    --space-md: 20px;',
      '  }',
      '}',
      '.button { --local-ignored: 8px; }',
    ].join('\n')

    const parsed = parseTokensCssWithSpans(css)
    expect(parsed.themes).toEqual(['[data-theme="dark"]', '@media (prefers-color-scheme: dark)'])
    expect(parsed.tokens).toEqual([
      {
        name: '--color-brand',
        group: 'color',
        kind: 'color',
        value: '#2563eb',
        themes: { '[data-theme="dark"]': '#60a5fa' },
      },
      {
        name: '--space-md',
        group: 'space',
        kind: 'length',
        value: '16px',
        themes: { '@media (prefers-color-scheme: dark)': '20px' },
      },
      {
        name: '--font-sans',
        group: 'font',
        kind: 'text',
        value: '"Inter; Bold", system-ui',
        themes: {},
      },
    ])

    // Verify exact spans in `css`
    const rootBrand = parsed.spans.get(tokenDraftKey('--color-brand', null))!
    expect(css.slice(rootBrand.valueStart, rootBrand.valueEnd)).toBe('#2563eb')
    const rootSpace = parsed.spans.get(tokenDraftKey('--space-md', null))!
    expect(css.slice(rootSpace.valueStart, rootSpace.valueEnd)).toBe('16px')
    expect(rootSpace.hadImportant).toBe(true)
    const darkBrand = parsed.spans.get(tokenDraftKey('--color-brand', '[data-theme="dark"]'))!
    expect(css.slice(darkBrand.valueStart, darkBrand.valueEnd)).toBe('#60a5fa')
  })

  it('caps scanned canonical tokens at 200', () => {
    const lines = Array.from({ length: 225 }, (_, i) => `  --tok-${i}: ${i}px;`).join('\n')
    const parsed = parseTokensCssWithSpans(`:root {\n${lines}\n}`)
    expect(parsed.tokens).toHaveLength(200)
    expect(parsed.tokens[0]?.name).toBe('--tok-0')
    expect(parsed.tokens[199]?.name).toBe('--tok-199')
  })

  it('rewrites only altered value spans while preserving comments, whitespace, and !important byte-for-byte', () => {
    const css = [
      '/* Keep header exactly */',
      ':root {',
      '  --color-bg: #ffffff; /* surface */',
      '  --space-sm:  8px  !important ;',
      '  --radius-md: 6px;',
      '}',
      '',
      '[data-theme="dark"] {',
      '  --color-bg: #ffffff; /* identical line in dark theme to test disambiguation! */',
      '}',
      '',
    ].join('\n')

    const parsed = parseTokensCssWithSpans(css)
    const { edits, appliedChanges } = buildTokenEdits('tokens.css', css, parsed, [
      { name: '--space-sm', value: '12px' },
      { name: '--color-bg', theme: '[data-theme="dark"]', value: '#0b0f19' },
    ])

    expect(appliedChanges).toEqual([
      { name: '--space-sm', from: '8px', to: '12px' },
      { name: '--color-bg', theme: '[data-theme="dark"]', from: '#ffffff', to: '#0b0f19' },
    ])

    const updatedFiles = applyEdits(new Map([['tokens.css', utf8(css)]]), edits)
    const nextCss = text(updatedFiles.get('tokens.css')!)
    expect(nextCss).toBe(
      [
        '/* Keep header exactly */',
        ':root {',
        '  --color-bg: #ffffff; /* surface */',
        '  --space-sm:  12px  !important ;',
        '  --radius-md: 6px;',
        '}',
        '',
        '[data-theme="dark"] {',
        '  --color-bg: #0b0f19; /* identical line in dark theme to test disambiguation! */',
        '}',
        '',
      ].join('\n')
    )
  })

  it('coalesces >100 edits within MAX_EDITS (100) so updating 150 tokens in one save succeeds cleanly', () => {
    const decls = Array.from({ length: 160 }, (_, i) => `  --token-${i}: ${i}px;`).join('\n')
    const css = `:root {\n${decls}\n}\n`
    const parsed = parseTokensCssWithSpans(css)
    const changes = Array.from({ length: 150 }, (_, i) => ({ name: `--token-${i}`, value: `${i + 1000}px` }))
    const { edits } = buildTokenEdits('tokens.css', css, parsed, changes)
    expect(edits.length).toBeLessThanOrEqual(100)
    const nextCss = text(applyEdits(new Map([['tokens.css', utf8(css)]]), edits).get('tokens.css')!)
    expect(nextCss).toContain('  --token-0: 1000px;\n')
    expect(nextCss).toContain('  --token-149: 1149px;\n')
    expect(nextCss).toContain('  --token-150: 150px;\n')
  })

  it('rejects unknown tokens, duplicate changes, unchanged values, and invalid values', () => {
    const css = ':root { --color-brand: #112233; }'
    const parsed = parseTokensCssWithSpans(css)

    const codeOf = (fn: () => unknown): string | null => {
      try {
        fn()
        return null
      } catch (err) {
        return err instanceof DesignActionError ? err.code : String(err)
      }
    }

    expect(codeOf(() => buildTokenEdits('tokens.css', css, parsed, [{ name: '--missing', value: '#000' }]))).toBe(
      'unknown_token'
    )
    expect(
      codeOf(() => buildTokenEdits('tokens.css', css, parsed, [{ name: '--color-brand', value: '#112233' }]))
    ).toBe('no_changes')
    expect(
      codeOf(() =>
        buildTokenEdits('tokens.css', css, parsed, [
          { name: '--color-brand', value: '#000' },
          { name: '--color-brand', value: '#fff' },
        ])
      )
    ).toBe('invalid_tokens')
    expect(
      codeOf(() =>
        buildTokenEdits('tokens.css', css, parsed, [{ name: '--color-brand', value: 'url(https://evil.test)' }])
      )
    ).toBe('invalid_tokens')
  })

  it('formats concise token summaries and caches DesignService results across reads', async () => {
    expect(
      formatTokenSummary([
        { name: '--a', from: '1px', to: '2px' },
        { name: '--b', theme: '.dark', from: '#000', to: '#111' },
      ])
    ).toBe('Tokens: --a 1px → 2px, --b (.dark) #000 → #111')

    const manyChanges = Array.from({ length: 30 }, (_, i) => ({
      name: `--token-long-name-${i}`,
      from: '10px',
      to: '20px',
    }))
    const cappedSummary = formatTokenSummary(manyChanges)
    expect(cappedSummary.length).toBeLessThanOrEqual(500)
    expect(cappedSummary).toMatch(/, \+\d+ more$/)

    const tmp = tempDir()
    const store = new ArtifactStore(openDatabase(path.join(tmp.dir, 'artifacts.sqlite')))
    const blobs = new BlobStore(path.join(tmp.dir, 'blobs'))
    const clock = testClock()
    const admin = createArtifactAdmin({ store, blobs, clock: clock.now, quotaBytes: 4 * 1024 * 1024 })
    const service = createDesignService({ store, blobs, maxCacheEntries: 2 })
    try {
      const created = await admin.create({
        title: 'Cached Design',
        owner: { kind: 'local', id: 'local' },
        origin: { workspaceId: null, conversationId: null, conversationTitle: null },
        files: [
          { path: 'index.html', bytes: utf8('<!doctype html><link rel="stylesheet" href="tokens.css" crossorigin>') },
          { path: 'tokens.css', bytes: utf8(':root { --color-primary: #3b82f6; }') },
          {
            path: 'maestrly-design.json',
            bytes: utf8(
              JSON.stringify({
                schema: 'maestrly-prototype/v1',
                tokens: ['tokens.css'],
                screens: [{ id: 'home', name: 'Home', path: 'index.html', viewport: 'desktop' }],
              })
            ),
          },
        ],
      })
      const first = await service.getDesign(created.id, 1)
      const second = await service.getDesign(created.id, 1)
      expect(first).toBe(second)
      expect(first?.tokens).toEqual([
        { name: '--color-primary', group: 'color', kind: 'color', value: '#3b82f6', themes: {} },
      ])
    } finally {
      store.close()
      tmp.cleanup()
    }
  })
})
