// The conversation card: a thread with its replies, or the comment being written. Comments are typed here, in the
// viewer, and shown as text; the page never sees them.
import { avatar } from './avatar.js'
import { authorLabel, relativeTime, type Thread } from './comments-model.js'
import type { PublicComment, TextQuote, ViewerState } from './contract.js'
import { h, put } from './dom.js'
import type { Translate } from './i18n.js'
import { icon } from './icons.js'

const MAX_COMMENT_CHARS = 4000
const MAX_NAME_CHARS = 60
const MAX_TEXTAREA_PX = 160
const CONFIRM_MS = 3500

export interface CardContext {
  t: Translate
  locale: string
  state: ViewerState
  /** A guest without a name types one before their first comment. */
  needsName: boolean
}

export interface Composer {
  form: HTMLFormElement
  area: HTMLTextAreaElement
  name: HTMLInputElement | null
  /** Shows why the text was not sent. */
  fail(message: string): void
  /** While sending, the text cannot be sent again. */
  busy(on: boolean): void
}

function autosize(area: HTMLTextAreaElement): void {
  area.style.height = 'auto'
  area.style.height = `${Math.min(area.scrollHeight, MAX_TEXTAREA_PX)}px`
}

function selfFace(ctx: CardContext, size: number): HTMLElement {
  const { identity } = ctx.state
  return identity.kind === 'owner'
    ? avatar('owner', ctx.state.ownerName, size)
    : avatar(identity.kind, identity.name ?? '', size)
}

/** A text box that sends with Enter and keeps a new line with Shift+Enter. */
export function composer(
  ctx: CardContext,
  options: {
    placeholder: string
    submitLabel: string
    value: string
    withFoot?: { onCancel(): void }
    onInput(value: string): void
    onSubmit(body: string, name: string | null, composer: Composer): void
  }
): Composer {
  const { t } = ctx
  const area = h('textarea', {
    rows: '1',
    maxlength: String(MAX_COMMENT_CHARS),
    placeholder: options.placeholder,
    'aria-label': options.placeholder,
  })
  area.value = options.value
  const name = ctx.needsName
    ? h('input', {
        class: 'input',
        maxlength: String(MAX_NAME_CHARS),
        placeholder: t('yourName'),
        'aria-label': t('yourName'),
        autocomplete: 'name',
      })
    : null
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true })
  const send = h(
    'button',
    { type: 'submit', class: 'send', 'aria-label': options.submitLabel, title: options.submitLabel },
    icon('send', 15)
  )
  const form = h(
    'form',
    { class: 'composer', novalidate: true },
    name && h('div', { class: 'composer-name' }, name, h('p', {}, t('nameHint'))),
    h('div', { class: 'composer-row' }, selfFace(ctx, 26), area, send),
    error,
    options.withFoot &&
      h(
        'div',
        { class: 'composer-foot' },
        h('span', {}, t('composerHint')),
        h('button', { type: 'button', class: 'link', onclick: options.withFoot.onCancel }, t('cancel'))
      )
  )
  const result: Composer = {
    form,
    area,
    name,
    fail(message) {
      error.textContent = message
      error.hidden = false
    },
    busy(on) {
      sending = on
      send.disabled = on || !area.value.trim()
    },
  }
  let sending = false
  const sync = () => {
    send.disabled = !area.value.trim()
  }
  area.addEventListener('input', () => {
    options.onInput(area.value)
    autosize(area)
    sync()
    error.hidden = true
  })
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      form.requestSubmit()
    }
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const body = area.value.trim()
    if (!body || sending) return
    const typed = name ? name.value.trim() : null
    if (name && !typed) {
      result.fail(t('nameNeeded'))
      name.focus()
      return
    }
    options.onSubmit(body, typed, result)
  })
  sync()
  queueMicrotask(() => autosize(area))
  return result
}

/** Deleting asks once more, in place. */
function deleteButton(t: Translate, first: boolean, withReplies: boolean, onDelete: () => void): HTMLButtonElement {
  let armed: ReturnType<typeof setTimeout> | null = null
  const label = first ? t('deleteThread') : t('deleteReply')
  const control = h(
    'button',
    { type: 'button', class: 'entry-delete', 'aria-label': label, title: label },
    icon('trash', 13)
  )
  control.addEventListener('click', () => {
    if (!armed) {
      control.classList.add('is-armed')
      control.replaceChildren(first && withReplies ? t('confirmDeleteThread') : t('confirmDelete'))
      armed = setTimeout(() => {
        armed = null
        control.classList.remove('is-armed')
        control.replaceChildren(icon('trash', 13))
      }, CONFIRM_MS)
      return
    }
    clearTimeout(armed)
    armed = null
    onDelete()
  })
  return control
}

function message(
  ctx: CardContext,
  comment: PublicComment,
  first: boolean,
  withReplies: boolean,
  onDelete: () => void
): HTMLElement {
  const { t, state } = ctx
  const { author } = comment
  const owner = state.ownerName || t('theOwner')
  const verified = !author.self && (author.kind === 'invited' || author.kind === 'approved')
  const at = new Date(comment.createdAt)
  const line = h(
    'div',
    { class: 'entry' },
    avatar(author.kind, author.name, 26),
    h(
      'div',
      { class: 'entry-main' },
      h(
        'p',
        { class: 'entry-head' },
        h(
          'b',
          { class: author.kind === 'guest' && !author.self ? 'is-unverified' : undefined },
          authorLabel(t, author)
        ),
        verified &&
          h(
            'span',
            {
              class: 'tick',
              title: t(author.kind === 'invited' ? 'tickInvited' : 'tickApproved', { owner }),
              'aria-label': t(author.kind === 'invited' ? 'tickInvited' : 'tickApproved', { owner }),
            },
            icon('check', 11)
          ),
        h(
          'time',
          { datetime: at.toISOString(), title: at.toLocaleString(ctx.locale) },
          relativeTime(ctx.locale, comment.createdAt, Date.now(), t('now'))
        )
      ),
      // People outside the app wrote this: it is plain text, never markup.
      h('p', { class: 'entry-body' }, comment.body)
    )
  )
  if (comment.canDelete) line.append(deleteButton(t, first, withReplies, onDelete))
  return line
}

export interface ThreadCardOptions {
  thread: Thread
  /** Where the thread sits among those the reader steps through. */
  position: { at: number; total: number }
  /** Whether the passage or spot is missing from the version on screen; null while that is not known. */
  missing: boolean | null
  replyText: string
  onReplyInput(value: string): void
  onReply(body: string, name: string | null, composer: Composer): void
  onResolve(resolved: boolean): void
  onDelete(comment: PublicComment): void
  onStep(delta: number): void
  onClose(): void
}

export function threadCard(
  ctx: CardContext,
  options: ThreadCardOptions
): { el: HTMLElement; composer: Composer | null } {
  const { t, state } = ctx
  const { thread } = options
  const { comment } = thread
  const resolved = comment.status === 'resolved'
  const el = h('section', {
    class: `card${resolved ? ' is-resolved' : ''}`,
    tabindex: '-1',
    role: 'dialog',
    'aria-label': t('threadLabel', { author: authorLabel(t, comment.author) }),
  })
  const { at, total } = options.position
  const head = h(
    'header',
    { class: 'card-head' },
    total > 1 &&
      h(
        'span',
        { class: 'stepper' },
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('threadPrevious'),
            title: t('threadPrevious'),
            onclick: () => options.onStep(-1),
          },
          icon('left', 15)
        ),
        h('span', { class: 'stepper-at' }, t('threadAt', { n: at + 1, total })),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('threadNext'),
            title: t('threadNext'),
            onclick: () => options.onStep(1),
          },
          icon('right', 15)
        )
      ),
    h('span', { class: 'card-spacer' }),
    state.can.resolve &&
      h(
        'button',
        { type: 'button', class: 'button small', onclick: () => options.onResolve(!resolved) },
        icon('check', 14),
        resolved ? t('reopen') : t('resolve')
      ),
    h(
      'button',
      {
        type: 'button',
        class: 'icon-button',
        'aria-label': t('closeThread'),
        title: t('closeThread'),
        onclick: options.onClose,
      },
      icon('close', 15)
    )
  )
  const body = h('div', { class: 'card-body' })
  const quote = comment.anchor?.quote?.exact
  put(
    body,
    quote && h('blockquote', { class: 'card-quote' }, quote),
    options.missing && h('p', { class: 'card-note is-warn' }, quote ? t('passageMissing') : t('spotMissing')),
    !comment.anchor?.quote && !comment.anchor?.point && h('p', { class: 'card-note' }, t('aboutPage')),
    resolved && h('p', { class: 'card-note' }, t('resolved'))
  )
  const withReplies = thread.replies.length > 0
  body.append(message(ctx, comment, true, withReplies, () => options.onDelete(comment)))
  for (const reply of thread.replies) body.append(message(ctx, reply, false, false, () => options.onDelete(reply)))
  el.append(head, body)

  let reply: Composer | null = null
  if (state.can.comment) {
    reply = composer(ctx, {
      placeholder: t('placeholderReply'),
      submitLabel: t('sendReply'),
      value: options.replyText,
      onInput: options.onReplyInput,
      onSubmit: options.onReply,
    })
    el.append(reply.form)
  }
  return { el, composer: reply }
}

export function draftCard(
  ctx: CardContext,
  options: {
    quote: TextQuote | null
    onPage: boolean
    text: string
    onInput(value: string): void
    onSubmit(body: string, name: string | null, composer: Composer): void
    onCancel(): void
  }
): { el: HTMLElement; composer: Composer } {
  const { t } = ctx
  const title = options.onPage ? t('pageComment') : t('newComment')
  const el = h('section', { class: 'card is-draft', tabindex: '-1', role: 'dialog', 'aria-label': title })
  const form = composer(ctx, {
    placeholder: options.onPage ? t('placeholderPage') : t('placeholderComment'),
    submitLabel: t('sendComment'),
    value: options.text,
    withFoot: { onCancel: options.onCancel },
    onInput: options.onInput,
    onSubmit: options.onSubmit,
  })
  put(
    el,
    h(
      'header',
      { class: 'card-head' },
      h('span', { class: 'card-title' }, title),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': t('cancel'),
          title: t('cancel'),
          onclick: options.onCancel,
        },
        icon('close', 15)
      )
    ),
    options.quote && h('blockquote', { class: 'card-quote' }, options.quote.exact),
    form.form
  )
  return { el, composer: form }
}
