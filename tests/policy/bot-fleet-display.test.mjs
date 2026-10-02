import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../deploy/bot-fleet/prepare-xvfb-display.sh', import.meta.url))

function scenario(displayActive) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fleet-display-'))
  try {
    const lock = path.join(directory, 'X0.lock')
    const socket = path.join(directory, 'X0')
    writeFileSync(lock, 'old pid')
    writeFileSync(socket, 'old socket')
    const xdpyinfo = path.join(directory, 'xdpyinfo')
    writeFileSync(xdpyinfo, '#!/bin/sh\nexit ' + (displayActive ? '0' : '1') + '\n', { mode: 0o755 })
    const result = spawnSync('sh', [script, ':0', lock, socket], {
      env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH },
      encoding: 'utf8',
    })
    return { status: result.status, lock: existsSync(lock), socket: existsSync(socket) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('removes stale Xvfb display files before restart', () => {
  assert.deepEqual(scenario(false), { status: 0, lock: false, socket: false })
})

test('leaves a live display untouched', () => {
  assert.deepEqual(scenario(true), { status: 1, lock: true, socket: true })
})

// The look of each bot's apps display: the Openbox theme, the dock, the launchers and the icons that ship in the image.
const deploy = fileURLToPath(new URL('../../deploy/bot-fleet/', import.meta.url))
const read = (...segments) => readFileSync(path.join(deploy, ...segments), 'utf8')
const desktopFiles = readdirSync(path.join(deploy, 'desktop/applications')).filter((name) => name.endsWith('.desktop'))
const desktopEntry = (file) =>
  Object.fromEntries(
    read('desktop/applications', file)
      .split('\n')
      .filter((line) => /^[A-Za-z][A-Za-z0-9-]*(\[[A-Za-z_@]+\])?=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
/** The settings of a tint2rc, in order, and the backgrounds it declares (a block starts at each `rounded`). */
function tint2(text) {
  const settings = new Map()
  const backgrounds = []
  for (const line of text.split('\n')) {
    const match = /^([a-z0-9_]+) = (.*)$/.exec(line.trim())
    if (!match) continue
    const [, key, value] = match
    if (key === 'rounded') backgrounds.push({})
    if (backgrounds.length && /^(rounded|border_|background_)/.test(key)) backgrounds.at(-1)[key] = value
    else settings.set(key, [...(settings.get(key) ?? []), value])
  }
  return { settings, backgrounds, one: (key) => settings.get(key)?.at(-1) }
}

test('the Dockerfile installs the desktop programs and copies the desktop, its theme and its launchers', () => {
  const dockerfile = read('bot-instance.Dockerfile')
  for (const packageName of [
    'hsetroot',
    'librsvg2-bin',
    'xterm',
    'pcmanfm',
    'mousepad',
    'libxdamage1',
    'libxfixes3',
    'libxext6',
  ])
    assert.match(
      dockerfile,
      new RegExp(`apt-get install[^\\n]*\\\\\\n(?:[^\\n]*\\\\\\n)*[^\\n]*\\b${packageName}\\b`),
      packageName
    )
  assert.match(dockerfile, /^COPY deploy\/bot-fleet\/desktop \/opt\/maestrly\/desktop$/m)
  assert.match(dockerfile, /^COPY deploy\/bot-fleet\/desktop\/theme\/Maestrly \/usr\/share\/themes\/Maestrly$/m)
  assert.match(dockerfile, /^COPY deploy\/bot-fleet\/desktop\/applications\/ \/usr\/share\/applications\/$/m)
  // xterm, which has no bitmap fonts in the image, gets its dark look and an Xft font from its app defaults.
  assert.match(dockerfile, /cat \/opt\/maestrly\/desktop\/xterm\/XTerm >> \/etc\/X11\/app-defaults\/XTerm/)
  const xterm = read('desktop/xterm/XTerm')
  assert.match(xterm, /^\*faceName: DejaVu Sans Mono$/m)
  assert.match(xterm, /^\*background: #0b0b0d$/m)
})

test('the bot display uses the Maestrly theme with a minimize button, and the environment display stays as it was', () => {
  const rc = read('openbox-rc.xml')
  assert.match(rc, /<name>Maestrly<\/name>/)
  assert.match(rc, /<titleLayout>NLIMC<\/titleLayout>/)
  assert.doesNotMatch(rc, /No iconify button/)
  assert.match(rc, /<context name="Iconify">[\s\S]*<action name="Iconify"\/>/)
  // A configuration file replaces Openbox's defaults entirely: every binding the bots and their owners use stays.
  for (const binding of ['A-F4', 'A-F10', 'A-F7', 'A-F8', 'A-Tab']) assert.ok(rc.includes(`key="${binding}"`), binding)
  for (const context of ['Titlebar', 'Client', 'Icon', 'Maximize', 'Close', 'Root', 'Top', 'BRCorner'])
    assert.match(rc, new RegExp(`<context name="[^"]*\\b${context}\\b`), context)
  // The environment display keeps Clearlooks and its frame, which Maestrly measures to keep windows inside their tiles.
  const environment = read('openbox-environment-rc.xml')
  assert.match(environment, /<name>Clearlooks<\/name><titleLayout>LC<\/titleLayout>/)
})

test('the Maestrly theme has dark bars, light text and a glyph for every title bar button', () => {
  const themerc = read('desktop/theme/Maestrly/openbox-3/themerc')
  const value = (key) => new RegExp(`^${key.replaceAll('.', '\\.')}:\\s*(\\S+)\\s*$`, 'm').exec(themerc)?.[1]
  assert.equal(value('window.active.title.bg.color'), '#1c1c1f')
  assert.equal(value('window.inactive.title.bg.color'), '#161618')
  assert.equal(value('window.active.label.text.color'), '#edeae3')
  assert.match(value('window.inactive.label.text.color'), /^#[0-9a-f]{6}$/)
  assert.ok(Number(value('padding.height')) >= 8, 'the title bar is taller than the stock themes')
  for (const glyph of ['close', 'max', 'max_toggled', 'iconify']) {
    const xbm = read('desktop/theme/Maestrly/openbox-3', `${glyph}.xbm`)
    const width = Number(new RegExp(`#define ${glyph}_width (\\d+)`).exec(xbm)?.[1])
    const height = Number(new RegExp(`#define ${glyph}_height (\\d+)`).exec(xbm)?.[1])
    const bytes = [...xbm.slice(xbm.indexOf('{')).matchAll(/0x[0-9a-f]{2}/g)]
    assert.ok(width > 0 && height > 0, glyph)
    assert.equal(bytes.length, Math.ceil(width / 8) * height, `${glyph}.xbm holds every row`)
    assert.ok(
      bytes.some(([byte]) => byte !== '0x00'),
      `${glyph}.xbm draws something`
    )
  }
})

test('the dock keeps the launchers, open apps and clock in a translucent rounded bar over the wallpaper', () => {
  const dock = tint2(read('tint2rc'))
  assert.equal(dock.one('panel_items'), 'LTC')
  assert.equal(dock.one('panel_shrink'), '1')
  assert.equal(dock.one('panel_position'), 'bottom center horizontal')
  assert.equal(dock.one('panel_margin'), '0 10')
  assert.equal(dock.one('launcher_icon_size'), '44')
  assert.equal(dock.one('task_text'), '0')
  assert.equal(dock.one('task_icon'), '1')
  assert.equal(dock.one('launcher_tooltip'), '1')
  assert.equal(dock.one('task_tooltip'), '1')
  // The first background is the dock's; the pseudo transparency needs no compositor, only hsetroot's root pixmap.
  const panel = dock.backgrounds[Number(dock.one('panel_background_id')) - 1]
  assert.equal(panel.rounded, '18')
  assert.equal(panel.background_color, '#ffffff 28')
  assert.equal(panel.border_color, '#ffffff 50')
  assert.notEqual(dock.one('disable_transparency'), '1')
  // The taskbar's own "active" background must stay unset: with it set, tint2 paints a flat box in place of the wallpaper.
  assert.equal(dock.settings.has('taskbar_active_background_id'), false)
  assert.deepEqual(dock.settings.get('launcher_item_app'), [
    '/usr/share/applications/maestrly-browser.desktop',
    '/usr/share/applications/maestrly-terminal.desktop',
    '/usr/share/applications/maestrly-files.desktop',
  ])
})

test('the launchers name their app in English and Portuguese, run the Maestrly desktop and use shipped icons', () => {
  assert.deepEqual(desktopFiles, [
    'maestrly-browser.desktop',
    'maestrly-files.desktop',
    'maestrly-terminal.desktop',
    'maestrly-url.desktop',
  ])
  const launch = {
    browser: 'maestrly-desktop browser',
    terminal: 'maestrly-desktop terminal',
    files: 'maestrly-desktop files',
  }
  for (const file of desktopFiles) {
    const entry = desktopEntry(file)
    assert.equal(entry.Type, 'Application', file)
    assert.ok(entry.Name && entry['Name[pt_BR]'], `${file} has Name and Name[pt_BR]`)
    assert.notEqual(entry.Name, '', file)
    // TryExec would hide a launcher whose program is not installed yet instead of failing when it is used.
    assert.equal('TryExec' in entry, false, file)
    const icon = entry.Icon.replace('/opt/maestrly/desktop/', '')
    assert.ok(entry.Icon.startsWith('/opt/maestrly/desktop/icons/'), `${file} icon is an absolute path in the image`)
    assert.ok(existsSync(path.join(deploy, 'desktop', icon)), `${file} icon ${icon} exists`)
    const app = /^maestrly-(browser|terminal|files)\.desktop$/.exec(file)?.[1]
    if (app) {
      assert.equal(entry.Exec, launch[app], file)
      assert.notEqual(entry.NoDisplay, 'true', file)
    } else {
      // The link opener is a handler for web links and nothing the dock shows.
      assert.equal(entry.Exec, 'maestrly-open-url %u')
      assert.equal(entry.NoDisplay, 'true')
      assert.match(entry.MimeType, /x-scheme-handler\/http;/)
    }
  }
  for (const name of ['browser', 'terminal', 'files', 'editor']) {
    const svg = read('desktop/icons', `${name}.svg`)
    assert.match(svg, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 64 64"/, name)
    assert.ok(svg.trimEnd().endsWith('</svg>'), name)
  }
})

test('plain text opens in the text editor while web links keep their browser', () => {
  const entrypoint = read('bot-entrypoint.sh')
  const mime = /<<'MIME'\n([\s\S]*?)\nMIME\n/.exec(entrypoint)?.[1].split('\n')
  assert.deepEqual(mime, [
    '[Default Applications]',
    'x-scheme-handler/http=chromium.desktop',
    'x-scheme-handler/https=chromium.desktop',
    'text/html=chromium.desktop',
    'text/plain=org.xfce.mousepad.desktop',
  ])
  // The GTK 2 file manager reads its dark theme from this file; the GTK 3 programs get GTK_THEME from the display manager.
  assert.match(entrypoint, /cat > "\$HOME\/\.gtkrc-2\.0" <<'GTK2'\ngtk-theme-name = "Adwaita-dark"/)
})
