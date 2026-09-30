// What a visitor sees before the page: a personal invitation, an access request, or guest entry on a shared link.
import { type ArtifactApi, bodyOf } from './api.js'
import { busy, button, element, field } from './dom.js'
import { type EntryScreen, POLL_INTERVAL_MS } from './gate-model.js'
import type { Translate } from './i18n.js'

const MAX_NAME_CHARS = 60
const MAX_MESSAGE_CHARS = 280
const MAX_CODE_CHARS = 64

export interface GateContext {
  app: HTMLElement
  api: ArtifactApi
  t: Translate
  /** The owner's display name, or an empty string. */
  ownerName: string
  /** This browser now has a session: show the page. */
  onEntered(): void
  /** Decide again from the current state, without the invitation. */
  reconsider(note?: string): void
  unavailable(): void
}

export type GateScreen = Exclude<EntryScreen, { screen: 'viewer' } | { screen: 'unavailable' }>

let stopWaiting: (() => void) | null = null

/** Replaces the page with one entry screen. */
export function showEntry(screen: GateScreen, ctx: GateContext, note?: string): void {
  stopWaiting?.()
  stopWaiting = null
  if (screen.screen === 'invite') void showInvite(screen.token, ctx)
  else if (screen.screen === 'request') showRequest(ctx, note)
  else if (screen.screen === 'waiting') showWaiting(ctx)
  else if (screen.screen === 'denied') show(ctx, ctx.t('deniedTitle'), [ctx.t('deniedDetail')])
  else showGuest(screen.code, ctx)
}

const ownerOr = (ctx: GateContext, owner = ctx.ownerName): string => owner || ctx.t('theOwner')

function show(ctx: GateContext, title: string, paragraphs: string[], ...rest: HTMLElement[]): HTMLElement {
  const main = element('main', 'gate')
  main.append(element('h1', undefined, title))
  for (const paragraph of paragraphs) main.append(element('p', undefined, paragraph))
  main.append(...rest)
  ctx.app.replaceChildren(main)
  document.title = title
  return main
}

function errorLine(): HTMLElement {
  const line = element('p', 'error')
  line.setAttribute('role', 'alert')
  line.hidden = true
  return line
}

const say = (line: HTMLElement, text: string): void => {
  line.textContent = text
  line.hidden = false
}

/** A personal link. Nothing is exchanged until the visitor confirms who they are. */
async function showInvite(token: string, ctx: GateContext): Promise<void> {
  const { t, api } = ctx
  const preview = await api.write('invite/preview', 'POST', { token }).catch(() => null)
  if (preview?.status !== 200) return ctx.reconsider()
  const body = await bodyOf(preview)
  const name = typeof body.name === 'string' ? body.name : ''
  const owner = typeof body.ownerName === 'string' ? body.ownerName : ''
  if (!name) return ctx.reconsider()

  const error = errorLine()
  const accept = button(t('inviteContinue', { name }), 'button primary')
  const decline = button(t('inviteNotMe', { name }), 'button')
  accept.addEventListener('click', () =>
    busy(accept, async () => {
      const response = await api.write('session/invite', 'POST', { token }).catch(() => null)
      if (response?.status === 204) return ctx.onEntered()
      if (response?.status === 409) return say(error, t('tooManyDevices', { owner: ownerOr(ctx, owner) }))
      if (response?.status === 404) return ctx.reconsider()
      say(error, t('tryLater'))
    })
  )
  decline.addEventListener('click', () =>
    busy(decline, async () => {
      await api.write('invite/decline', 'POST', { token }).catch(() => null)
      ctx.reconsider()
    })
  )
  const actions = element('div', 'actions')
  actions.append(accept, decline)
  show(
    ctx,
    owner ? t('inviteTitle', { owner, name }) : t('inviteTitleNoOwner', { name }),
    [],
    actions,
    error,
    element('p', 'note', t('stored'))
  )
  accept.focus()
}

function showRequest(ctx: GateContext, note?: string): void {
  const { t, api } = ctx
  const form = element('form', 'form')
  form.noValidate = true
  const name = field({ label: t('yourName'), maxLength: MAX_NAME_CHARS, autocomplete: 'name' })
  const message = field({ label: t('requestMessage'), maxLength: MAX_MESSAGE_CHARS, multiline: true })
  const counter = element('span', 'counter', `0 / ${MAX_MESSAGE_CHARS}`)
  message.root.append(counter)
  message.input.addEventListener('input', () => {
    counter.textContent = `${message.input.value.length} / ${MAX_MESSAGE_CHARS}`
  })
  const error = errorLine()
  const submit = element('button', 'button primary', t('requestSend'))
  submit.type = 'submit'
  form.append(name.root, message.root, error, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void busy(submit, async () => {
      if (!name.input.value.trim()) {
        name.input.focus()
        return say(error, t('requestFailed'))
      }
      const response = await api
        .write('access-requests', 'POST', { name: name.input.value, message: message.input.value })
        .catch(() => null)
      if (response?.status === 202) return showEntry({ screen: 'waiting' }, ctx)
      if (response?.status === 403) return showEntry({ screen: 'denied' }, ctx)
      if (response?.status === 404) return ctx.unavailable()
      say(error, response?.status === 429 ? t('requestsFull') : t('requestFailed'))
    })
  })
  show(
    ctx,
    ctx.ownerName ? t('requestTitle', { owner: ctx.ownerName }) : t('requestTitleNoOwner'),
    note ? [note, t('requestDetail')] : [t('requestDetail')],
    form,
    element('p', 'note', t('stored'))
  )
  name.input.focus()
}

/** Asks how the request is doing every few seconds, only while the tab is visible. */
function showWaiting(ctx: GateContext): void {
  const { t, api } = ctx
  const main = show(ctx, t('waitingTitle'), [t('waitingDetail', { owner: ownerOr(ctx) })])
  main.setAttribute('aria-live', 'polite')
  let stopped = false
  let checking = false
  const check = async () => {
    if (stopped || checking || document.visibilityState !== 'visible') return
    checking = true
    const response = await api.read('access-requests/current').catch(() => null)
    checking = false
    if (stopped || !response) return
    if (response.status === 404) return stop(() => ctx.unavailable())
    if (response.status !== 200) return
    const status = (await bodyOf(response)).status
    if (status === 'approved') stop(() => ctx.onEntered())
    else if (status === 'denied') stop(() => showEntry({ screen: 'denied' }, ctx))
    else if (status === 'expired') stop(() => ctx.reconsider(t('requestExpired')))
  }
  const timer = setInterval(() => void check(), POLL_INTERVAL_MS)
  const onVisible = () => void check()
  document.addEventListener('visibilitychange', onVisible)
  function stop(then?: () => void): void {
    stopped = true
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisible)
    then?.()
  }
  stopWaiting = () => stop()
  void check()
}

function showGuest(needsCode: boolean, ctx: GateContext): void {
  const { t, api } = ctx
  const form = element('form', 'form')
  form.noValidate = true
  const code = needsCode
    ? field({ label: t('accessCode'), maxLength: MAX_CODE_CHARS, type: 'password', autocomplete: 'off' })
    : null
  const error = errorLine()
  const submit = element('button', 'button primary', t('guestEnter'))
  submit.type = 'submit'
  if (code) form.append(code.root)
  form.append(error, submit)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void busy(submit, async () => {
      const response = await api.write('session/code', 'POST', code ? { code: code.input.value } : {}).catch(() => null)
      if (response?.status === 204) return ctx.onEntered()
      if (response?.status === 404) return ctx.reconsider()
      if (response?.status === 403) {
        say(error, t('wrongCode'))
        code?.input.select()
        return
      }
      if (response?.status === 429) {
        const reason = (await bodyOf(response)).error
        const seconds = Number(response.headers.get('retry-after')) || 60
        return say(
          error,
          reason === 'too_many_guests' ? t('tooManyGuests') : t('tooManyAttempts', { minutes: Math.ceil(seconds / 60) })
        )
      }
      say(error, t('tryLater'))
    })
  })
  show(ctx, t('guestTitle'), [needsCode ? t('guestCodeDetail') : t('guestDetail')], form)
  ;(code?.input ?? submit).focus()
}
