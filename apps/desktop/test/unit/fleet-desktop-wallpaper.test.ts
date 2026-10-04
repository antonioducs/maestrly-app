import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { paintWallpaper } from '../../src/main/fleet/instance/desktop/paint-wallpaper'
import { DEFAULT_WALLPAPER_TINT, mixHex, wallpaperSvg } from '../../src/main/fleet/instance/desktop/wallpaper'

/** The text nodes of the SVG, which hold the bot's initial and name. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((match) => match[1])
}

describe('mixHex', () => {
  it('mixes two colors channel by channel, rounding to the nearest value', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#102030', '#ffffff', 0)).toBe('#102030')
    expect(mixHex('#102030', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#e2e3ee', '#8b6cf0', 0.2)).toBe('#d1cbee')
  })

  it('accepts upper case digits and keeps the share inside zero to one', () => {
    expect(mixHex('#FFFFFF', '#000000', 0.5)).toBe('#808080')
    expect(mixHex('#102030', '#ffffff', -3)).toBe('#102030')
    expect(mixHex('#102030', '#ffffff', 9)).toBe('#ffffff')
    expect(mixHex('#102030', '#ffffff', Number.NaN)).toBe('#102030')
  })

  it('refuses colors that are not six hex digits', () => {
    for (const color of ['', '#fff', 'red', '#12345g', '#1234567', '102030'])
      expect(() => mixHex(color, '#ffffff', 0.5), color).toThrow(/color/i)
    expect(() => mixHex('#ffffff', 'rgb(0,0,0)', 0.5)).toThrow(/color/i)
  })
})

describe('wallpaperSvg', () => {
  it('draws a 1280 by 800 screen with the gradient stops mixed from the tint', () => {
    const svg = wallpaperSvg({ name: 'Ada', tint: '#8b6cf0' })
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('width="1280" height="800"')
    // Soft light corner, deeper opposite corner, a highlight and a glow, all derived from #8b6cf0.
    expect(svg).toContain('<stop offset="0" stop-color="#d1cbee"/>')
    expect(svg).toContain('<stop offset="1" stop-color="#968cd2"/>')
    expect(svg).toContain('stop-color="#e7e2f9"')
    expect(svg).toContain('stop-color="#7767c1"')
    // The bot's square uses the tint itself, and the screen carries the subtle pattern of the prototype.
    expect(svg).toMatch(/<rect [^>]*fill="#8b6cf0"/)
    expect(svg).toContain('<pattern')
  })

  it('shows the initial in a rounded square and the name below it, both centered', () => {
    const svg = wallpaperSvg({ name: 'Ada', tint: '#3f9fd8' })
    expect(texts(svg)).toEqual(['A', 'Ada'])
    expect(svg.match(/<text\b[^>]*text-anchor="middle"/g)).toHaveLength(2)
    expect(svg).toMatch(/<rect [^>]*rx="\d+"[^>]*fill="#3f9fd8"/)
  })

  it('escapes the name for XML and never lets it open a tag', () => {
    const svg = wallpaperSvg({ name: 'Bot & "Co" <x>', tint: '#8b6cf0' })
    expect(texts(svg)).toEqual(['B', 'Bot &amp; &quot;Co&quot; &lt;x&gt;'])
    expect(svg).not.toContain('<x>')
    expect(svg).not.toMatch(/Bot & /)
    const attack = wallpaperSvg({ name: '</text><script>alert(1)</script>', tint: '#8b6cf0' })
    expect(attack).not.toContain('<script')
    expect(attack).not.toContain('</text><')
    expect(attack.match(/<\/text>/g)).toHaveLength(2)
    expect(wallpaperSvg({ name: "Dani's", tint: null })).toContain('Dani&apos;s')
  })

  it('drops characters XML cannot hold', () => {
    const svg = wallpaperSvg({ name: 'A\u0000B\u0007C\u001fD\ufffeE\ud800F', tint: null })
    expect(texts(svg)[1]).toBe('ABCDEF')
    expect(svg).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/)
  })

  it('uses the first letter of the name, upper case, whatever the script', () => {
    expect(texts(wallpaperSvg({ name: 'élan', tint: null }))).toEqual(['É', 'élan'])
    expect(texts(wallpaperSvg({ name: '  maria  ', tint: null }))[0]).toBe('M')
    expect(texts(wallpaperSvg({ name: 'ßeta', tint: null }))[0]).toBe('S')
    expect(texts(wallpaperSvg({ name: '日本語', tint: null }))[0]).toBe('日')
    // One user-perceived character, not half of a surrogate pair.
    expect(texts(wallpaperSvg({ name: '👩‍💻 dev', tint: null }))[0]).toBe('👩‍💻')
    expect(texts(wallpaperSvg({ name: '𝒜da', tint: null }))[0]).toBe('𝒜')
  })

  it('has an initial even when the name has no visible letter', () => {
    expect(texts(wallpaperSvg({ name: '', tint: null }))[0]).toBe('?')
    expect(texts(wallpaperSvg({ name: '   ', tint: null }))[0]).toBe('?')
    expect(texts(wallpaperSvg({ name: '\u0000', tint: null }))[0]).toBe('?')
  })

  it('falls back to the neutral color for a missing or invalid tint', () => {
    expect(DEFAULT_WALLPAPER_TINT).toBe('#6b6b78')
    const neutral = wallpaperSvg({ name: 'Ada', tint: '#6b6b78' })
    for (const tint of [
      undefined,
      null,
      '',
      'purple',
      '#fff',
      '#8b6cf',
      '#8b6cf0f',
      '#zzzzzz',
      'rgb(1,2,3)',
      '#8b6cf0"',
    ]) {
      expect(wallpaperSvg({ name: 'Ada', tint }), String(tint)).toBe(neutral)
    }
    expect(neutral).toMatch(/<rect [^>]*fill="#6b6b78"/)
    expect(neutral).not.toContain('#8b6cf0')
  })

  it('treats upper and lower case hex digits alike', () => {
    expect(wallpaperSvg({ name: 'Ada', tint: '#8B6CF0' })).toBe(wallpaperSvg({ name: 'Ada', tint: '#8b6cf0' }))
  })

  it('keeps a name of the longest length inside the screen', () => {
    const svg = wallpaperSvg({ name: 'W'.repeat(40), tint: '#8b6cf0' })
    const size = Number(/<text\b[^>]*font-size="(\d+(?:\.\d+)?)"[^>]*>W{40}<\/text>/.exec(svg)?.[1])
    // The widest Latin letters are about 1em wide; leave a margin on both sides of the 1280 pixel screen.
    expect(size * 40).toBeLessThanOrEqual(1280 - 2 * 80)
    expect(size).toBeGreaterThanOrEqual(16)
  })
})

describe.skipIf(process.platform === 'win32')('paintWallpaper', () => {
  let root: string
  let bin: string
  let folder: string
  let log: string

  /** A program that records how it was called; `body` runs after the record and decides how it ends. */
  const fake = (name: string, body: string): void => {
    const file = path.join(bin, name)
    writeFileSync(file, `#!/bin/sh\nprintf '${name} DISPLAY=%s %s\\n' "$DISPLAY" "$*" >> "${log}"\n${body}\n`)
    chmodSync(file, 0o755)
  }
  /** Stands in for rsvg-convert: writes a file where `-o` says, as the real program does. */
  const WRITE_OUTPUT = 'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then printf png > "$2"; fi; shift; done'
  const calls = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean)

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'maestrly-wallpaper-'))
    bin = path.join(root, 'bin')
    folder = path.join(root, 'home', '.cache', 'maestrly-bots', 'alpha')
    log = path.join(root, 'calls.log')
    writeFileSync(log, '')
    rmSync(bin, { recursive: true, force: true })
    mkdirSync(bin)
    vi.stubEnv('PATH', bin)
    fake('rsvg-convert', WRITE_OUTPUT)
    fake('hsetroot', 'exit 0')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the SVG, renders it at the size of the screen and sets it on the display of the bot', async () => {
    await paintWallpaper({ folder, display: ':2', name: 'Ada', tint: '#8b6cf0' })
    expect(readFileSync(path.join(folder, 'wallpaper.svg'), 'utf8')).toBe(
      wallpaperSvg({ name: 'Ada', tint: '#8b6cf0' })
    )
    expect(calls()).toEqual([
      `rsvg-convert DISPLAY= -w 1280 -h 800 -o ${folder}/wallpaper.png ${folder}/wallpaper.svg`,
      `hsetroot DISPLAY=:2 -cover ${folder}/wallpaper.png`,
    ])
  })

  it('paints again with the new name and color, in the same files', async () => {
    await paintWallpaper({ folder, display: ':2', name: 'Ada', tint: '#8b6cf0' })
    await paintWallpaper({ folder, display: ':2', name: 'Grace', tint: '#3f9fd8' })
    const svg = readFileSync(path.join(folder, 'wallpaper.svg'), 'utf8')
    expect(svg).toBe(wallpaperSvg({ name: 'Grace', tint: '#3f9fd8' }))
    expect(svg).not.toContain('Ada')
    expect(calls()).toHaveLength(4)
  })

  it('leaves the screen alone and says why when the rendering fails', async () => {
    fake('rsvg-convert', "echo 'Could not parse the document' >&2; exit 3")
    await expect(paintWallpaper({ folder, display: ':2', name: 'Ada' })).rejects.toThrow(
      'rsvg-convert failed (3): Could not parse the document'
    )
    expect(calls().map((call) => call.split(' ')[0])).toEqual(['rsvg-convert'])
    // The next painting works once the program does.
    fake('rsvg-convert', WRITE_OUTPUT)
    await paintWallpaper({ folder, display: ':2', name: 'Ada' })
    expect(calls().map((call) => call.split(' ')[0])).toEqual(['rsvg-convert', 'rsvg-convert', 'hsetroot'])
  })

  it('reports a root image that cannot be set', async () => {
    fake('hsetroot', "echo 'Cannot open display' >&2; exit 1")
    await expect(paintWallpaper({ folder, display: ':2', name: 'Ada' })).rejects.toThrow(
      'hsetroot failed (1): Cannot open display'
    )
  })

  it('reports a program that is not installed', async () => {
    rmSync(path.join(bin, 'hsetroot'))
    await expect(paintWallpaper({ folder, display: ':2', name: 'Ada' })).rejects.toThrow('hsetroot is not installed')
    rmSync(path.join(bin, 'rsvg-convert'))
    await expect(paintWallpaper({ folder, display: ':2', name: 'Ada' })).rejects.toThrow(
      'rsvg-convert is not installed'
    )
  })

  it('stops a program that takes too long', async () => {
    fake('rsvg-convert', 'while :; do :; done')
    await expect(paintWallpaper({ folder, display: ':2', name: 'Ada' }, { timeoutMs: 300 })).rejects.toThrow(
      'rsvg-convert did not finish within 0.3 s'
    )
    // Nothing runs after it. Under load the stand-in may be stopped before it records its own call, so only what
    // would come next is checked.
    expect(calls().filter((call) => !call.startsWith('rsvg-convert '))).toEqual([])
  })

  it('refuses to paint when the folder cannot be made', async () => {
    writeFileSync(path.join(root, 'home'), 'a file where the folder should go')
    await expect(paintWallpaper({ folder, display: ':2', name: 'Ada' })).rejects.toThrow()
    expect(calls()).toEqual([])
  })
})
