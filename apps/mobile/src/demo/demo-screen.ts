import { FLEET_SCREEN } from '@maestrly/bot-fleet-protocol'
import { GatewayError } from '../gateway/client'
import type { OpenScreen, ScreenLinkEvent, ScreenMode } from '../screen/link'

const W = FLEET_SCREEN.width
const H = FLEET_SCREEN.height
type Box = { x: number; y: number; w: number; h: number }
/** The sign-in form's parts, in screen pixels. */
const FIELDS = {
  email: { x: 440, y: 330, w: 400, h: 46 },
  password: { x: 440, y: 418, w: 400, h: 46 },
  button: { x: 440, y: 500, w: 400, h: 46 },
} satisfies Record<string, Box>
type Field = keyof typeof FIELDS
const ORDER: Field[] = ['email', 'password', 'button']
/** Where the bot left its pointer: on the password it could not type. */
const BOT_POINTER = { x: 640, y: 441 }
const IDLE_POINTER = { x: 1010, y: 214 }

/** The demo's screen of one bot: a browser on its staging site's admin, signed out or in. */
type Page = { phase: 'login' | 'signing' | 'signed'; focus: Field | null; password: string; error: string | null }
type Viewer = { botId: string; mode: ScreenMode; onEvent: (event: ScreenLinkEvent) => void; buttons: number }

const UNICODE_KEYSYM_BASE = 0x0100_0000
const RETURN = 0xff0d
const TAB = 0xff09
const BACKSPACE = 0xff08
const ESCAPE = 0xff1b

const inside = (box: Box, x: number, y: number) => x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
const esc = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function field(box: Box, focused: boolean, content: string, placeholder: boolean): string {
  const ring = focused
    ? `<rect x="${box.x - 4}" y="${box.y - 4}" width="${box.w + 8}" height="${box.h + 8}" rx="11" fill="#0b6e6e" opacity=".15"/>`
    : ''
  const caret = focused
    ? `<rect x="${box.x + 18 + Math.min(content.length, 40) * 9}" y="${box.y + 12}" width="2" height="22" fill="#0b6e6e"/>`
    : ''
  return `${ring}<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8" fill="#fff" stroke="${focused ? '#0b6e6e' : '#c3cbd3'}" stroke-width="${focused ? 2 : 1.5}"/>
<text x="${box.x + 16}" y="${box.y + 29}" font-size="16" fill="${placeholder ? '#9aa4ae' : '#1d2329'}">${esc(content)}</text>${caret}`
}

function chrome(tab: string, url: string): string {
  return `<rect width="${W}" height="${H}" fill="#f3f5f7"/>
<rect width="${W}" height="28" fill="#121212"/>
<text x="14" y="19" font-size="13" fill="#e8e8e8">Activities</text>
<text x="${W / 2}" y="19" font-size="13" fill="#e8e8e8" text-anchor="middle">Thu 22 Oct · 09:41</text>
<rect y="28" width="${W}" height="38" fill="#dee1e6"/>
<path d="M8 66 V42 a8 8 0 0 1 8 -8 h234 a8 8 0 0 1 8 8 V66 Z" fill="#fff"/>
<rect x="20" y="44" width="14" height="14" rx="3" fill="#0b6e6e"/>
<text x="44" y="56" font-size="12.5" fill="#1f1f1f">${esc(tab)}</text>
<rect y="66" width="${W}" height="40" fill="#fff"/>
<text x="16" y="92" font-size="17" fill="#5f6368">←  →  ↻</text>
<rect x="104" y="72" width="${W - 120}" height="28" rx="14" fill="#f1f3f4"/>
<text x="124" y="91" font-size="13" fill="#3c4043">${esc(url)}</text>
<rect y="105" width="${W}" height="1" fill="#e3e6ea"/>`
}

function loginPage(page: Page): string {
  const busy = page.phase === 'signing'
  const button = FIELDS.button
  return `${chrome('Sign in · Staging admin', 'staging.example.dev/admin/login')}
<rect x="400" y="170" width="480" height="440" rx="12" fill="#fff" stroke="#dde2e7"/>
<circle cx="453" cy="216" r="13" fill="#0b6e6e"/><circle cx="453" cy="216" r="6" fill="#63b3a6"/>
<text x="476" y="222" font-size="17" font-weight="600" fill="#12343b">Staging admin</text>
<text x="440" y="270" font-size="26" font-weight="600" fill="#1d2329">Sign in</text>
<text x="440" y="298" font-size="14.5" fill="#4b5560">Use the e2e test account to reach the admin pages.</text>
<text x="440" y="322" font-size="13" font-weight="600" fill="#333c45">Email</text>
${field(FIELDS.email, page.focus === 'email', 'e2e-admin@example.dev', false)}
<text x="440" y="410" font-size="13" font-weight="600" fill="#333c45">Password</text>
${field(FIELDS.password, page.focus === 'password', page.password ? '•'.repeat(page.password.length) : 'Password', !page.password)}
${page.error ? `<text x="440" y="486" font-size="13" fill="#c5221f">${esc(page.error)}</text>` : ''}
${page.focus === 'button' ? `<rect x="${button.x - 4}" y="${button.y - 4}" width="${button.w + 8}" height="${button.h + 8}" rx="11" fill="#0b6e6e" opacity=".2"/>` : ''}
<rect x="${button.x}" y="${button.y}" width="${button.w}" height="${button.h}" rx="8" fill="#0b6e6e" opacity="${busy ? 0.65 : 1}"/>
<text x="${button.x + button.w / 2}" y="${button.y + 29}" font-size="15" font-weight="600" fill="#fff" text-anchor="middle">${busy ? 'Signing in…' : 'Sign in'}</text>
<text x="440" y="580" font-size="14" font-weight="600" fill="#0b6e6e">Forgot password?</text>`
}

const USERS = [
  ['Ana Ribeiro', 'Owner', 'Active'],
  ['Bruno Costa', 'Admin', 'Active'],
  ['e2e-admin', 'Admin', 'Active'],
  ['Carla Mendes', 'Editor', 'Invited'],
  ['Diego Alves', 'Viewer', 'Active'],
]

function signedPage(): string {
  const rows = USERS.map(
    (
      [name, role, state],
      index
    ) => `<rect x="40" y="${280 + index * 50}" width="${W - 80}" height="50" fill="#fff" stroke="#eef1f4"/>
<text x="60" y="${311 + index * 50}" font-size="14" fill="#1d2329">${name}</text>
<text x="520" y="${311 + index * 50}" font-size="14" fill="#4b5560">${role}</text>
<rect x="900" y="${294 + index * 50}" width="70" height="22" rx="11" fill="${state === 'Active' ? '#e3f4ec' : '#eef1f4'}"/>
<text x="935" y="${310 + index * 50}" font-size="12" fill="${state === 'Active' ? '#1d6b47' : '#6b7580'}" text-anchor="middle">${state}</text>`
  )
  return `${chrome('Users · Staging admin', 'staging.example.dev/admin/users')}
<rect y="106" width="${W}" height="58" fill="#fff"/><rect y="163" width="${W}" height="1" fill="#e3e6ea"/>
<circle cx="53" cy="135" r="13" fill="#0b6e6e"/><circle cx="53" cy="135" r="6" fill="#63b3a6"/>
<text x="76" y="141" font-size="17" font-weight="600" fill="#12343b">Staging admin</text>
<text x="300" y="140" font-size="14" fill="#4b5560">Overview</text>
<text x="400" y="140" font-size="14" font-weight="600" fill="#0b6e6e">Users</text>
<text x="480" y="140" font-size="14" fill="#4b5560">Settings</text>
<rect x="40" y="184" width="380" height="34" rx="8" fill="#e3f4ec"/>
<text x="56" y="206" font-size="13.5" fill="#1d6b47">✓ Signed in as e2e-admin@example.dev</text>
<text x="40" y="258" font-size="22" font-weight="600" fill="#1d2329">Users</text>
<rect x="40" y="230" width="${W - 80}" height="1" fill="none"/>
${rows.join('\n')}`
}

function picture(page: Page): string {
  const body = page.phase === 'signed' ? signedPage() : loginPage(page)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">${body}</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

function character(keysym: number): string | null {
  if ((keysym >= 0x20 && keysym <= 0x7e) || (keysym >= 0xa0 && keysym <= 0xff)) return String.fromCharCode(keysym)
  if (keysym > UNICODE_KEYSYM_BASE) return String.fromCodePoint(keysym - UNICODE_KEYSYM_BASE)
  return null
}

/**
 * The demo's bot screens: a browser on a staging site's admin, as a still picture redrawn after each change. A bot that
 * waits on a sign-in starts signed out, with its pointer on the password; the owner taps the field, types any password
 * and signs in. Control needs the bot's takeover, as on a gateway.
 */
export function demoScreens(options: {
  /** Whether this phone holds the bot's takeover. */
  controls: (botId: string) => boolean
  /** Whether the bot waits on a sign-in when its screen first opens. */
  signedOut: (botId: string) => boolean
  /** Milliseconds per second of the demo's own pace. */
  scale?: number
}) {
  const scale = options.scale ?? 1
  const pages = new Map<string, Page>()
  const viewers = new Set<Viewer>()
  const pageOf = (botId: string): Page => {
    let page = pages.get(botId)
    if (!page) {
      page = options.signedOut(botId)
        ? { phase: 'login', focus: null, password: '', error: null }
        : { phase: 'signed', focus: null, password: '', error: null }
      pages.set(botId, page)
    }
    return page
  }
  const show = (botId: string) => {
    const uri = picture(pageOf(botId))
    for (const viewer of viewers) if (viewer.botId === botId) viewer.onEvent({ type: 'picture', uri })
  }
  const submit = (botId: string) => {
    const page = pageOf(botId)
    if (page.phase !== 'login') return
    if (!page.password) {
      page.error = 'Enter the password.'
      return
    }
    page.error = null
    page.focus = null
    page.phase = 'signing'
    setTimeout(() => {
      page.phase = 'signed'
      show(botId)
    }, 900 * scale)
  }
  const click = (botId: string, x: number, y: number) => {
    const page = pageOf(botId)
    if (page.phase !== 'login') return
    page.focus = ORDER.find((name) => inside(FIELDS[name], x, y)) ?? null
    if (page.focus === 'button') submit(botId)
  }
  const key = (botId: string, keysym: number) => {
    const page = pageOf(botId)
    if (page.phase !== 'login') return
    if (keysym === RETURN) {
      if (page.focus) submit(botId)
    } else if (keysym === TAB) page.focus = ORDER[(ORDER.indexOf(page.focus ?? 'button') + 1) % ORDER.length]
    else if (keysym === ESCAPE) page.focus = null
    else if (keysym === BACKSPACE) {
      if (page.focus === 'password') page.password = page.password.slice(0, -1)
    } else {
      const typed = character(keysym)
      if (typed && page.focus === 'password') {
        page.password = (page.password + typed).slice(0, 40)
        page.error = null
      }
    }
  }

  const open: OpenScreen = (request, onEvent) => {
    const viewer: Viewer = { botId: request.botId, mode: request.mode, onEvent, buttons: 0 }
    let closed = false
    const timer = setTimeout(() => {
      if (closed) return
      if (request.mode === 'control' && !options.controls(request.botId)) {
        closed = true
        onEvent({ type: 'end', end: { error: new GatewayError('FORBIDDEN', 403, 'Takeover required for control') } })
        return
      }
      viewers.add(viewer)
      onEvent({ type: 'open', width: W, height: H })
      const page = pageOf(request.botId)
      onEvent({ type: 'picture', uri: picture(page) })
      if (request.mode === 'view')
        onEvent({ type: 'pointer', ...(page.phase === 'login' ? BOT_POINTER : IDLE_POINTER) })
    }, 450 * scale)
    const input = (apply: () => void) => {
      if (closed || viewer.mode !== 'control' || !viewers.has(viewer)) return
      apply()
      show(request.botId)
    }
    return {
      pointer(x, y, buttons) {
        const pressed = buttons & 1 && !(viewer.buttons & 1)
        viewer.buttons = buttons
        if (pressed) input(() => click(request.botId, x, y))
      },
      wheel: () => undefined,
      key(keysym, down) {
        if (down) input(() => key(request.botId, keysym))
      },
      decoded: () => undefined,
      decoderFailed: () => undefined,
      close() {
        closed = true
        clearTimeout(timer)
        viewers.delete(viewer)
      },
    }
  }

  return {
    open,
    /** The bot's screen was given back: its control sessions end, as the gateway closes them. */
    released(botId: string) {
      for (const viewer of [...viewers]) {
        if (viewer.botId !== botId || viewer.mode !== 'control') continue
        viewers.delete(viewer)
        viewer.onEvent({ type: 'end', end: { code: 4001, reason: 'released' } })
      }
    },
  }
}
