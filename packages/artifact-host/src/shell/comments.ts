// The comments panel of the viewer. Comments are typed and shown here, in the shell, never inside the page: the page
// only learns which of its own passages to highlight. Everything is rendered with `textContent`.
import { type ArtifactApi, bodyOf } from './api.js'
import { authorLabel, groupComments, quotesToHighlight, type Thread } from './comments-model.js'
import type {
  BridgeMessage,
  CommentPage,
  PublicComment,
  SelectionRect,
  ShellMessage,
  TextQuote,
  ViewerState,
} from './contract.js'
import { busy, button, element, field } from './dom.js'
import type { Translate } from './i18n.js'

const MAX_COMMENT_CHARS = 4000
const MAX_NAME_CHARS = 60
/** Pages of 200 comments: enough for every comment an artifact can hold. */
const MAX_PAGES = 10
const ACTION_GAP = 8
const CONFIRM_MS = 4000

export interface CommentsOptions {
  api: ArtifactApi
  t: Translate
  locale: string
  state: ViewerState
  /** The content frame, which the floating button is placed over and highlight requests are sent to. */
  frame: HTMLIFrameElement
  version: number
  /** A guest chose the name their comments are signed with. */
  onNamed(name: string): void
}

export interface CommentsView {
  /** The header button that shows and hides the panel. */
  toggle: HTMLButtonElement
  panel: HTMLElement
  /** The "Comment" button shown over a selection; it goes in the same box as the frame. */
  action: HTMLButtonElement
  setVersion(version: number): void
  handle(message: BridgeMessage): void
}

export function createComments(options: CommentsOptions): CommentsView {
  const { api, t, frame, state } = options
  const canComment = state.can.comment
  const dates = new Intl.DateTimeFormat(options.locale, { dateStyle: 'medium', timeStyle: 'short' })

  let comments: PublicComment[] = []
  let version = options.version
  let open = false
  let loaded = false
  let failed = false
  let selection: { quote: TextQuote; rect: SelectionRect } | null = null
  let composing: { quote: TextQuote | null } | null = null
  let replyingTo: string | null = null
  let activeId: string | null = null
  // A guest signs comments with a name of their choice; null until they choose one.
  let needsName = state.identity.kind === 'guest' && !state.identity.name
  const missing = new Set<string>()

  const toggle = button(t('comments'), 'button comments-toggle')
  toggle.setAttribute('aria-expanded', 'false')
  const count = element('span', 'count')
  toggle.append(count)
  const panel = element('aside', 'comments')
  panel.setAttribute('aria-label', t('comments'))
  panel.hidden = true
  const action = button(t('commentAction'), 'button primary comment-action')
  action.hidden = true

  const threadsOf = () => groupComments(comments, version)

  /** Asks the page to highlight the commented passages. Only quotes travel: text the page already has. */
  function highlight(): void {
    const message: ShellMessage = {
      source: 'maestrly-shell',
      type: 'highlight',
      quotes: open ? quotesToHighlight(threadsOf().current) : [],
      active: activeId,
    }
    // The frame's origin is opaque, so the message cannot be addressed to a specific one.
    frame.contentWindow?.postMessage(message, '*')
  }

  function placeAction(): void {
    const stage = action.parentElement
    if (!selection || !canComment || composing || !stage) {
      action.hidden = true
      return
    }
    action.hidden = false
    const { rect } = selection
    const width = action.offsetWidth
    const height = action.offsetHeight
    const left = Math.min(
      Math.max(rect.x + rect.width / 2 - width / 2, ACTION_GAP),
      stage.clientWidth - width - ACTION_GAP
    )
    const above = rect.y - height - ACTION_GAP
    const top = above >= ACTION_GAP ? above : rect.y + rect.height + ACTION_GAP
    action.style.left = `${Math.max(left, ACTION_GAP)}px`
    action.style.top = `${Math.min(Math.max(top, ACTION_GAP), Math.max(stage.clientHeight - height - ACTION_GAP, ACTION_GAP))}px`
  }

  async function load(): Promise<void> {
    const all: PublicComment[] = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const response = await api.read(cursor ? `comments?cursor=${encodeURIComponent(cursor)}` : 'comments')
        if (response.status !== 200) throw new Error(String(response.status))
        const body = (await response.json()) as CommentPage
        all.push(...body.comments)
        cursor = body.nextCursor
        if (!cursor) break
      }
      comments = all
      failed = false
    } catch {
      failed = true
    }
    loaded = true
    render()
    highlight()
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

  /** Explains a refused write. */
  async function explain(response: Response | null): Promise<string> {
    if (response?.status === 403) return t('commentsOff')
    if (response?.status === 409) {
      const reason = (await bodyOf(response)).error
      return reason === 'too_many_comments' ? t('commentsFull') : t('commentNameNeeded')
    }
    return t('commentFailed')
  }

  function composer(): HTMLElement {
    const form = element('form', 'composer')
    form.noValidate = true
    const quote = composing?.quote
    if (quote) {
      form.append(element('p', 'composer-label', t('commentOn')))
      form.append(element('blockquote', 'quote', quote.exact))
    }
    const name = needsName ? field({ label: t('yourName'), maxLength: MAX_NAME_CHARS, autocomplete: 'name' }) : null
    if (name) form.append(name.root, element('p', 'hint', t('commentNameHint')))
    const text = element('textarea')
    text.maxLength = MAX_COMMENT_CHARS
    text.rows = 3
    text.placeholder = t('commentPlaceholder')
    text.setAttribute('aria-label', t('commentPlaceholder'))
    const error = errorLine()
    const submit = element('button', 'button primary', t('commentSubmit'))
    submit.type = 'submit'
    const cancel = button(t('commentCancel'), 'button', () => {
      composing = null
      render()
      placeAction()
    })
    const actions = element('div', 'composer-actions')
    actions.append(cancel, submit)
    form.append(text, error, actions)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void busy(submit, async () => {
        const body = text.value.trim()
        if (!body) return say(error, t('commentEmpty'))
        if (name) {
          const chosen = name.input.value.trim()
          if (!chosen) {
            name.input.focus()
            return say(error, t('commentNameNeeded'))
          }
          const named = await api.write('session/name', 'PUT', { name: chosen }).catch(() => null)
          if (named?.status !== 204) return say(error, t('commentFailed'))
          needsName = false
          options.onNamed(chosen)
        }
        const response = await api
          .write('comments', 'POST', { version, body, ...(quote ? { anchor: { quote } } : {}) })
          .catch(() => null)
        if (response?.status !== 201) return say(error, await explain(response))
        const created = (await response.json()) as PublicComment
        comments = [...comments, created]
        composing = null
        activeId = created.id
        render()
        highlight()
      })
    })
    queueMicrotask(() => (name?.input ?? text).focus())
    return form
  }

  function replyBox(thread: Thread): HTMLElement {
    const form = element('form', 'composer reply')
    form.noValidate = true
    const text = element('textarea')
    text.maxLength = MAX_COMMENT_CHARS
    text.rows = 2
    text.placeholder = t('commentReplyPlaceholder')
    text.setAttribute('aria-label', t('commentReplyPlaceholder'))
    const error = errorLine()
    const submit = element('button', 'button primary', t('commentReply'))
    submit.type = 'submit'
    const cancel = button(t('commentCancel'), 'button', () => {
      replyingTo = null
      render()
    })
    const actions = element('div', 'composer-actions')
    actions.append(cancel, submit)
    form.append(text, error, actions)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void busy(submit, async () => {
        const body = text.value.trim()
        if (!body) return say(error, t('commentEmpty'))
        const response = await api.write(`comments/${thread.comment.id}/replies`, 'POST', { body }).catch(() => null)
        if (response?.status !== 201) return say(error, await explain(response))
        comments = [...comments, (await response.json()) as PublicComment]
        replyingTo = null
        render()
      })
    })
    queueMicrotask(() => text.focus())
    return form
  }

  /** Deleting asks once more, in place. */
  function deleteButton(comment: PublicComment): HTMLButtonElement {
    let armed: ReturnType<typeof setTimeout> | null = null
    const control = button(t('commentDelete'), 'link danger')
    control.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!armed) {
        control.textContent = t('commentDeleteConfirm')
        armed = setTimeout(() => {
          armed = null
          control.textContent = t('commentDelete')
        }, CONFIRM_MS)
        return
      }
      clearTimeout(armed)
      void busy(control, async () => {
        const response = await api.write(`comments/${comment.id}`, 'DELETE').catch(() => null)
        if (response?.status !== 204 && response?.status !== 404) {
          armed = null
          control.textContent = t('commentDelete')
          return
        }
        comments = comments.filter((item) => item.id !== comment.id && item.parentId !== comment.id)
        if (activeId === comment.id) activeId = null
        render()
        highlight()
      })
    })
    return control
  }

  function commentNode(comment: PublicComment): HTMLElement {
    const node = element('div', 'comment')
    const head = element('div', 'comment-head')
    const author = element('span', 'comment-author', authorLabel(t, comment.author))
    if (comment.author.kind === 'guest') author.classList.add('unverified')
    const when = element('time', 'comment-date', dates.format(comment.createdAt))
    when.dateTime = new Date(comment.createdAt).toISOString()
    head.append(author, when)
    node.append(head, element('p', 'comment-body', comment.body))
    return node
  }

  function threadNode(thread: Thread, other: boolean): HTMLElement {
    const { comment } = thread
    const node = element('article', 'thread')
    node.dataset.id = comment.id
    if (comment.status === 'resolved') node.classList.add('resolved')
    if (comment.id === activeId) node.classList.add('active')
    const tags = element('div', 'thread-tags')
    if (other) tags.append(element('span', 'tag', t('commentVersion', { n: comment.version })))
    if (comment.status === 'resolved') tags.append(element('span', 'tag', t('commentResolved')))
    if (tags.childElementCount) node.append(tags)
    const quote = comment.anchor?.quote
    if (quote) {
      node.append(element('blockquote', 'quote', quote.exact))
      const note = element('p', 'missing', t('commentMissing'))
      note.hidden = other || !missing.has(comment.id)
      node.append(note)
    }
    node.append(commentNode(comment))
    for (const reply of thread.replies) {
      const replyNode = commentNode(reply)
      replyNode.classList.add('is-reply')
      if (reply.canDelete) replyNode.append(deleteButton(reply))
      node.append(replyNode)
    }
    const controls = element('div', 'thread-actions')
    if (canComment && replyingTo !== comment.id)
      controls.append(
        button(t('commentReply'), 'link', () => {
          replyingTo = comment.id
          render()
        })
      )
    if (state.can.resolve) {
      const resolved = comment.status === 'resolved'
      const control = button(resolved ? t('commentReopen') : t('commentResolve'), 'link')
      control.addEventListener('click', (event) => {
        event.stopPropagation()
        void busy(control, async () => {
          const response = await api
            .write(`comments/${comment.id}/resolve`, 'POST', { resolved: !resolved })
            .catch(() => null)
          if (response?.status !== 204) return
          comments = comments.map(
            (item): PublicComment =>
              item.id === comment.id ? { ...item, status: resolved ? 'open' : 'resolved' } : item
          )
          render()
          highlight()
        })
      })
      controls.append(control)
    }
    if (comment.canDelete) controls.append(deleteButton(comment))
    if (controls.childElementCount) node.append(controls)
    if (replyingTo === comment.id) node.append(replyBox(thread))
    // Choosing a thread shows its passage in the page.
    node.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button, textarea, input, form')) return
      activeId = activeId === comment.id ? null : comment.id
      for (const each of panel.querySelectorAll<HTMLElement>('.thread'))
        each.classList.toggle('active', each.dataset.id === activeId)
      highlight()
    })
    return node
  }

  function render(): void {
    const { current, earlier } = threadsOf()
    const openCount = current.filter((thread) => thread.comment.status === 'open').length
    count.textContent = openCount ? String(openCount) : ''
    count.hidden = openCount === 0
    toggle.setAttribute('aria-expanded', String(open))
    toggle.title = open ? t('commentsClose') : t('commentsOpen')
    panel.hidden = !open
    if (!open) return

    const head = element('div', 'comments-head')
    head.append(element('h2', undefined, t('comments')))
    head.append(button('×', 'icon', () => setOpen(false)))
    ;(head.lastElementChild as HTMLElement).setAttribute('aria-label', t('commentsClose'))
    const body = element('div', 'comments-body')
    if (failed) body.append(element('p', 'error', t('commentsLoadFailed')))
    if (!canComment) body.append(element('p', 'hint', t('commentsOff')))
    if (composing) body.append(composer())
    else if (canComment)
      body.append(
        button(t('commentOnPage'), 'button add-comment', () => {
          composing = { quote: null }
          render()
        })
      )
    if (loaded && !failed && current.length === 0 && !composing) {
      body.append(element('p', 'empty', t('commentsEmpty')))
      if (canComment) body.append(element('p', 'hint', t('commentsHint')))
    }
    for (const thread of current) body.append(threadNode(thread, false))
    if (earlier.length) {
      const newer = earlier.some((thread) => thread.comment.version > version)
      body.append(element('h3', 'comments-section', t(newer ? 'commentsOther' : 'commentsEarlier')))
      for (const thread of earlier) body.append(threadNode(thread, true))
    }
    panel.replaceChildren(head, body)
  }

  function setOpen(next: boolean): void {
    open = next
    if (!open) {
      composing = null
      replyingTo = null
    }
    render()
    placeAction()
    if (open && !composing) void load()
    else highlight()
  }

  toggle.addEventListener('click', () => setOpen(!open))
  // The button must not take the selection away before the click is handled.
  action.addEventListener('mousedown', (event) => event.preventDefault())
  action.addEventListener('click', () => {
    if (!selection) return
    composing = { quote: selection.quote }
    replyingTo = null
    open = true
    render()
    placeAction()
    if (!loaded) void load()
  })
  window.addEventListener('resize', placeAction)
  // Other people comment too: coming back to the tab shows what is new, unless something is being written.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && open && !composing && !replyingTo) void load()
  })

  // The count is worth showing before the panel is opened.
  void load()

  return {
    toggle,
    panel,
    action,
    setVersion(next) {
      version = next
      selection = null
      composing = null
      activeId = null
      missing.clear()
      render()
      placeAction()
    },
    handle(message) {
      if (message.type === 'ready') highlight()
      else if (message.type === 'selection') {
        selection = message.quote && message.rect ? { quote: message.quote, rect: message.rect } : null
        placeAction()
      } else if (message.type === 'anchors') {
        for (const id of message.found) missing.delete(id)
        for (const id of message.missing) missing.add(id)
        // Updated in place: rebuilding the panel would discard what is being typed.
        for (const node of panel.querySelectorAll<HTMLElement>('.thread')) {
          const note = node.querySelector<HTMLElement>(':scope > .missing')
          const id = node.dataset.id
          if (note && id && (message.found.includes(id) || message.missing.includes(id))) note.hidden = !missing.has(id)
        }
      }
    },
  }
}
