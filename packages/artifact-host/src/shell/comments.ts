// Comments on the page, as in a design tool: a pin where each conversation is, its card beside it, and a list of all
// of them. Pins, cards and the list live in the viewer, above the frame. The page is told only what to find (its own
// text, or places in it) and reports where those are; it never receives a name or what a comment says.
import type { ArtifactApi } from './api.js'
import { bodyOf } from './api.js'
import { avatar } from './avatar.js'
import {
  anchorsFor,
  authorLabel,
  buildThreads,
  firstSeen,
  flipsLeft,
  hasPin,
  isUnread,
  type ListFilter,
  listThreads,
  markSeen,
  offscreen,
  openCounts,
  parseSeen,
  pinnedThreads,
  placeCard,
  pruneSeen,
  relativeTime,
  type SeenState,
  snippet,
  steppable,
  type Thread,
} from './comments-model.js'
import {
  type BridgeMessage,
  type CommentPage,
  DRAFT_ANCHOR_ID,
  type PickedAnchor,
  type PinPosition,
  type PublicComment,
  type SelectionRect,
  type ShellMessage,
  type TextQuote,
  type ViewerState,
} from './contract.js'
import { h, put, toast } from './dom.js'
import { plural, type Translate } from './i18n.js'
import { icon } from './icons.js'
import { type CardContext, type Composer, draftCard, threadCard } from './thread.js'

/** Pages of 200 comments: enough for every comment an artifact can hold. */
const MAX_PAGES = 10
const REFRESH_MS = 30_000
const PREVIEW_CHARS = 110
const LIST_CHARS = 140

export interface CommentsOptions {
  api: ArtifactApi
  t: Translate
  locale: string
  state: ViewerState
  frame: HTMLIFrameElement
  /** The area around the page; the card is placed within it. */
  stage: HTMLElement
  /** Above the frame, in its coordinates: pins, the selection button and the off-screen chips. */
  overlay: HTMLElement
  /** Above the stage: the card and the comment-mode hint. */
  float: HTMLElement
  list: HTMLElement
  version: number
  /** Something the top bar shows changed. */
  onChange(): void
  /** A thread from another version was chosen: show that version. */
  onShowVersion(version: number): void
}

export interface CommentsController {
  readonly commenting: boolean
  readonly listOpen: boolean
  openCounts(): Map<number, number>
  setCommenting(on: boolean): void
  setList(open: boolean): void
  /** A new version is being loaded into the frame. */
  setVersion(version: number): void
  handle(message: BridgeMessage): void
  /** Closes what Escape should close; false when there was nothing. */
  escape(): boolean
  /** The frame changed size or place: put everything back on its passage. */
  relayout(): void
}

interface Draft {
  /** Null for a comment about the whole page. */
  anchor: PickedAnchor | null
}

export function createComments(options: CommentsOptions): CommentsController {
  const { api, t, locale, state, frame, stage, overlay, float, list } = options
  const canComment = state.can.comment
  const seenKey = `maestrly.comments.seen.${state.artifact.id}`

  let comments: PublicComment[] = []
  let threads: Thread[] = []
  let version = options.version
  let commenting = false
  let listOpen = false
  let listFilter: ListFilter = 'open'
  let activeId: string | null = null
  let hoverId: string | null = null
  let draft: Draft | null = null
  let draftText = ''
  let replyText = ''
  let selection: { quote: TextQuote; rect: SelectionRect } | null = null
  let positions: Record<string, PinPosition> = {}
  let frameSize = { width: 0, height: 0 }
  let pendingReveal: string | null = null
  let seen: SeenState | null = null
  let loaded = false
  let failed = false

  const ctx = (): CardContext => ({
    t,
    locale,
    state,
    needsName: state.identity.kind === 'guest' && !state.identity.name,
  })
  const when = (at: number) => relativeTime(locale, at, Date.now(), t('now'))
  const threadOf = (id: string | null) => (id ? threads.find((thread) => thread.comment.id === id) : undefined)
  // The frame's origin is opaque, so the message cannot be addressed to a specific one.
  const toPage = (message: ShellMessage) =>
    frame.contentWindow?.postMessage({ source: 'maestrly-shell', ...message }, '*')

  // --- Unread, per browser.

  function saveSeen(): void {
    if (!seen) return
    try {
      localStorage.setItem(seenKey, JSON.stringify(seen))
    } catch {
      // Without storage, what is new is only known until the page is closed.
    }
  }
  function readSeen(): SeenState | null {
    try {
      return parseSeen(localStorage.getItem(seenKey))
    } catch {
      return null
    }
  }
  const unread = (thread: Thread) => seen !== null && isUnread(thread, seen)
  function seeThread(thread: Thread): void {
    if (!seen) return
    seen = markSeen(seen, thread)
    saveSeen()
  }

  // --- Loading and saving.

  function setComments(next: PublicComment[]): void {
    comments = next
    threads = buildThreads(comments)
    if (activeId && !threadOf(activeId)) activeId = null
    if (!seen) seen = readSeen() ?? firstSeen(comments)
    seen = pruneSeen(seen, threads)
    const active = threadOf(activeId)
    if (active) seen = markSeen(seen, active)
    saveSeen()
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
      failed = false
    } catch {
      failed = true
      loaded = true
      renderList()
      return
    }
    loaded = true
    const changed = JSON.stringify(all) !== JSON.stringify(comments)
    if (!changed && threads.length) return renderList()
    setComments(all)
    refresh()
  }

  /** Why a comment was refused, in the reader's words. */
  async function refusal(response: Response | null): Promise<string> {
    if (response?.status === 403) return t('commentsOff')
    if (response?.status === 409) {
      const reason = (await bodyOf(response)).error
      return reason === 'too_many_comments' ? t('commentsFull') : t('nameNeeded')
    }
    return t('commentFailed')
  }

  /** A guest's first comment carries the name they typed. */
  async function nameYourself(name: string | null, composer: Composer): Promise<boolean> {
    if (!name || state.identity.kind !== 'guest') return true
    const response = await api.write('session/name', 'PUT', { name }).catch(() => null)
    if (response?.status !== 204) {
      composer.fail(t('commentFailed'))
      return false
    }
    state.identity = { kind: 'guest', name }
    options.onChange()
    return true
  }

  async function send(
    composer: Composer,
    name: string | null,
    request: () => Promise<Response>,
    done: (created: PublicComment) => void
  ): Promise<void> {
    composer.busy(true)
    try {
      if (!(await nameYourself(name, composer))) return
      const response = await request().catch(() => null)
      if (response?.status !== 201) return composer.fail(await refusal(response))
      done((await response.json()) as PublicComment)
    } finally {
      composer.busy(false)
    }
  }

  function submitDraft(body: string, name: string | null, composer: Composer): void {
    const anchor = draft?.anchor ?? null
    void send(
      composer,
      name,
      () => api.write('comments', 'POST', { version, body, ...(anchor ? { anchor } : {}) }),
      (created) => {
        draft = null
        draftText = ''
        toPage({ type: 'clear-selection' })
        setComments([...comments, created])
        activeId = created.id
        refresh()
        focusCard()
      }
    )
  }

  function submitReply(thread: Thread, body: string, name: string | null, composer: Composer): void {
    void send(
      composer,
      name,
      () => api.write(`comments/${thread.comment.id}/replies`, 'POST', { body }),
      (created) => {
        replyText = ''
        setComments([...comments, created])
        refresh()
        const scroller = float.querySelector<HTMLElement>('.card-body')
        if (scroller) scroller.scrollTop = scroller.scrollHeight
        float.querySelector<HTMLTextAreaElement>('.card textarea')?.focus()
      }
    )
  }

  async function setResolved(thread: Thread, resolved: boolean, announce = true): Promise<void> {
    const response = await api.write(`comments/${thread.comment.id}/resolve`, 'POST', { resolved }).catch(() => null)
    if (response?.status !== 204) return toast(t('actionFailed'))
    setComments(
      comments.map(
        (item): PublicComment =>
          item.id === thread.comment.id ? { ...item, status: resolved ? 'resolved' : 'open' } : item
      )
    )
    if (resolved && activeId === thread.comment.id) activeId = null
    refresh()
    if (resolved && announce)
      toast(t('resolvedToast'), { label: t('undo'), run: () => void setResolved(thread, false, false) })
  }

  async function remove(comment: PublicComment): Promise<void> {
    const response = await api.write(`comments/${comment.id}`, 'DELETE').catch(() => null)
    if (response?.status !== 204 && response?.status !== 404) return toast(t('actionFailed'))
    setComments(comments.filter((item) => item.id !== comment.id && item.parentId !== comment.id))
    if (comment.parentId === null) {
      activeId = null
      toast(t('deletedToast'))
    }
    refresh()
  }

  // --- What the page is told to find.

  const showResolved = () => listOpen && listFilter === 'resolved'
  const pinned = () => pinnedThreads(threads, version, { showResolved: showResolved(), activeId })

  function sendAnchors(): void {
    const anchor = draft?.anchor ?? null
    toPage({
      type: 'anchors',
      anchors: anchorsFor(pinned(), anchor),
      active: anchor ? DRAFT_ANCHOR_ID : (activeId ?? hoverId),
    })
  }

  // --- Pins.

  function pinButton(thread: Thread): HTMLButtonElement {
    const { comment, replies } = thread
    const resolved = comment.status === 'resolved'
    const isUnreadNow = unread(thread)
    const author = authorLabel(t, comment.author)
    const text = snippet(comment.body, PREVIEW_CHARS)
    const label = [
      t(isUnreadNow ? 'pinLabelUnread' : 'pinLabel', { author, text }),
      replies.length ? plural(t, replies.length, 'repliesOne', 'repliesMany') : '',
    ]
      .filter(Boolean)
      .join('. ')
    const pin = h(
      'button',
      {
        type: 'button',
        class: `pin${isUnreadNow ? ' is-unread' : ''}${resolved ? ' is-resolved' : ''}${
          comment.id === activeId ? ' is-active' : ''
        }`,
        'data-pin': comment.id,
        'aria-label': label,
        'aria-expanded': String(comment.id === activeId),
        hidden: true,
        onclick: () => (comment.id === activeId ? closeThread() : openThread(comment.id)),
        onpointerenter: () => hover(comment.id),
        onpointerleave: () => hover(null),
        onfocus: () => hover(comment.id),
        onblur: () => hover(null),
      },
      h(
        'span',
        { class: 'pin-bubble' },
        resolved
          ? h('span', { class: 'avatar is-done' }, icon('check', 13))
          : avatar(comment.author.kind, comment.author.name, 24),
        replies.length > 0 && h('span', { class: 'pin-count' }, String(replies.length + 1)),
        h(
          'span',
          { class: 'pin-preview', 'aria-hidden': 'true' },
          h('span', { class: 'pin-who' }, h('b', {}, author), h('span', {}, when(comment.createdAt))),
          h('span', { class: 'pin-text' }, text),
          replies.length > 0 && h('span', { class: 'pin-more' }, plural(t, replies.length, 'repliesOne', 'repliesMany'))
        )
      )
    )
    return pin
  }

  function renderPins(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.pin
    for (const pin of overlay.querySelectorAll('.pin')) pin.remove()
    for (const thread of pinned()) overlay.append(pinButton(thread))
    if (draft?.anchor) {
      const { identity } = state
      overlay.append(
        h(
          'span',
          { class: 'pin is-draft', 'data-pin': DRAFT_ANCHOR_ID, hidden: true },
          h(
            'span',
            { class: 'pin-bubble' },
            identity.kind === 'owner'
              ? avatar('owner', state.ownerName, 24)
              : avatar(identity.kind, identity.name ?? '', 24)
          )
        )
      )
    }
    if (focused) overlay.querySelector<HTMLElement>(`[data-pin="${CSS.escape(focused)}"]`)?.focus()
    placeAll()
  }

  function hover(id: string | null): void {
    if (hoverId === id) return
    hoverId = id
    if (!activeId && !draft) sendAnchors()
  }

  let pill: HTMLButtonElement | null = null
  function placeSelection(): void {
    if (!selection || commenting || draft || !canComment) {
      pill?.remove()
      pill = null
      return
    }
    if (!pill) {
      pill = h(
        'button',
        {
          type: 'button',
          class: 'selection-pill',
          // The page's selection must survive the press on this button.
          onmousedown: (event: MouseEvent) => event.preventDefault(),
          onclick: () => selection && startDraft({ quote: selection.quote }),
        },
        icon('comment', 14),
        t('selectionComment')
      )
      overlay.append(pill)
    }
    const { rect } = selection
    const width = pill.offsetWidth
    const above = rect.y - 40
    const top = above < 8 ? rect.y + rect.height + 8 : above
    pill.style.left = `${Math.min(Math.max(rect.x + rect.width - width / 2, 8), Math.max(8, frameSize.width - width - 8))}px`
    pill.style.top = `${Math.min(Math.max(top, 8), Math.max(8, frameSize.height - 40))}px`
  }

  let edgesKey = ''
  function renderEdges(): void {
    const open = pinned()
      .filter((thread) => thread.comment.status === 'open')
      .map((thread) => thread.comment.id)
    const { above, below } = offscreen(open, positions, frameSize.height)
    const key = `${above.join()}|${below.join()}`
    if (key === edgesKey) return
    edgesKey = key
    for (const chip of overlay.querySelectorAll('.edge')) chip.remove()
    const chip = (ids: string[], side: 'above' | 'below') =>
      ids.length > 0 &&
      h(
        'button',
        { type: 'button', class: `edge is-${side}`, onclick: () => toPage({ type: 'reveal', id: ids[0]! }) },
        icon(side === 'above' ? 'up' : 'down', 13),
        side === 'above'
          ? plural(t, ids.length, 'aboveOne', 'aboveMany')
          : plural(t, ids.length, 'belowOne', 'belowMany')
      )
    put(overlay, chip(above, 'above'), chip(below, 'below'))
  }

  function placeAll(): void {
    for (const pin of overlay.querySelectorAll<HTMLElement>('.pin')) {
      const at = positions[pin.dataset.pin ?? '']
      pin.hidden = !at
      if (!at) continue
      pin.style.setProperty('--x', `${at.x}px`)
      pin.style.setProperty('--y', `${at.y}px`)
      pin.classList.toggle('is-flipped', flipsLeft(at.x, frameSize.width))
    }
    placeSelection()
    renderEdges()
    positionCard()
  }

  // --- The card.

  let card: HTMLElement | null = null

  function focusCard(): void {
    const area = card?.querySelector<HTMLTextAreaElement>('textarea')
    ;(area ?? card)?.focus()
  }

  /** Rebuilds the card, keeping what is being typed, and the caret, when the text box had the focus. */
  function renderCard(): void {
    const typing = card?.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null
    const caret =
      typing instanceof HTMLTextAreaElement || typing instanceof HTMLInputElement
        ? { tag: typing.tagName, start: typing.selectionStart, end: typing.selectionEnd }
        : null
    card?.remove()
    card = null
    const active = threadOf(activeId)
    if (draft) {
      const built = draftCard(ctx(), {
        quote: draft.anchor && 'quote' in draft.anchor ? draft.anchor.quote : null,
        onPage: draft.anchor === null,
        text: draftText,
        onInput: (value) => {
          draftText = value
        },
        onSubmit: submitDraft,
        onCancel: cancelDraft,
      })
      card = built.el
    } else if (active) {
      const order = steppable(threads, version, activeId)
      const at = order.findIndex((thread) => thread.comment.id === active.comment.id)
      const anchored = hasPin(active)
      const known = active.comment.version === version && anchored && active.comment.id in positions
      const built = threadCard(ctx(), {
        thread: active,
        position: { at: Math.max(0, at), total: order.length },
        missing: known ? positions[active.comment.id] === null : null,
        replyText,
        onReplyInput: (value) => {
          replyText = value
        },
        onReply: (body, name, composer) => submitReply(active, body, name, composer),
        onResolve: (resolved) => void setResolved(active, resolved),
        onDelete: (comment) => void remove(comment),
        onStep: (delta) => {
          const next = order[(at + delta + order.length) % order.length]
          if (next) openThread(next.comment.id, true)
        },
        onClose: closeThread,
      })
      card = built.el
    }
    if (!card) return
    float.append(card)
    positionCard()
    if (caret) {
      const again = card.querySelector<HTMLTextAreaElement | HTMLInputElement>(caret.tag.toLowerCase())
      again?.focus()
      if (again && caret.start !== null) again.setSelectionRange(caret.start, caret.end ?? caret.start)
    }
  }

  function positionCard(): void {
    if (!card) return
    const id = draft ? (draft.anchor ? DRAFT_ANCHOR_ID : null) : activeId
    const pin = id ? overlay.querySelector<HTMLElement>(`[data-pin="${CSS.escape(id)}"]`) : null
    const bounds = stage.getBoundingClientRect()
    const frameBox = frame.getBoundingClientRect()
    let box: { left: number; top: number; width: number; height: number } | null = null
    let away = false
    if (pin && !pin.hidden) {
      const bubble = (pin.querySelector('.pin-bubble') ?? pin).getBoundingClientRect()
      // The card travels with its pin: while the pin is scrolled out of sight, so is the card. What was typed stays.
      away = bubble.bottom < frameBox.top + 8 || bubble.top > frameBox.bottom - 8
      box = {
        left: bubble.left - bounds.left,
        top: bubble.top - bounds.top,
        width: bubble.width,
        height: bubble.height,
      }
    }
    card.classList.toggle('is-away', away)
    const placed = placeCard(box, { width: card.offsetWidth, height: card.offsetHeight }, bounds)
    card.style.left = `${placed.left}px`
    card.style.top = `${placed.top}px`
    card.style.transformOrigin = `${placed.originX} ${placed.originY}px`
  }

  function openThread(id: string, reveal = false): void {
    const thread = threadOf(id)
    if (!thread) return
    if (thread.comment.version !== version) {
      // The other version loads first, which closes whatever was open; its page scrolls to the passage when ready.
      options.onShowVersion(thread.comment.version)
      pendingReveal = hasPin(thread) ? id : null
    } else if (hasPin(thread)) {
      const at = positions[id]
      if (reveal || (at && (at.y < 40 || at.y > frameSize.height - 20))) toPage({ type: 'reveal', id })
    }
    draft = null
    replyText = ''
    activeId = id
    seeThread(thread)
    refresh()
    focusCard()
  }

  function closeThread(): void {
    const id = activeId
    activeId = null
    draft = null
    refresh()
    if (id) overlay.querySelector<HTMLElement>(`[data-pin="${CSS.escape(id)}"]`)?.focus()
  }

  function startDraft(anchor: PickedAnchor | null): void {
    // A new spot keeps what was already typed.
    if (!draft) draftText = ''
    draft = { anchor }
    activeId = null
    selection = null
    refresh()
    focusCard()
  }

  function cancelDraft(): void {
    draft = null
    draftText = ''
    toPage({ type: 'clear-selection' })
    refresh()
  }

  // --- The list.

  function listItem(thread: Thread): HTMLElement {
    const { comment, replies } = thread
    const other = comment.version !== version
    const missing = !other && hasPin(thread) && positions[comment.id] === null
    const isUnreadNow = unread(thread)
    const quote = comment.anchor?.quote?.exact
    return h(
      'li',
      {},
      h(
        'button',
        {
          type: 'button',
          class: `item${comment.id === activeId ? ' is-active' : ''}${isUnreadNow ? ' is-unread' : ''}`,
          'aria-current': comment.id === activeId ? 'true' : undefined,
          onclick: () => openThread(comment.id, true),
        },
        avatar(comment.author.kind, comment.author.name, 26),
        h(
          'span',
          { class: 'item-main' },
          h(
            'span',
            { class: 'item-head' },
            h('b', {}, authorLabel(t, comment.author)),
            h('time', {}, when(comment.createdAt)),
            isUnreadNow && h('span', { class: 'dot', role: 'img', 'aria-label': t('unread') })
          ),
          quote && h('span', { class: 'item-quote' }, quote),
          h('span', { class: 'item-body' }, snippet(comment.body, LIST_CHARS)),
          h(
            'span',
            { class: 'item-meta' },
            other && h('span', { class: 'tag' }, t('tagVersion', { n: comment.version })),
            !hasPin(thread) && h('span', { class: 'tag' }, t('tagPage')),
            missing && h('span', { class: 'tag is-warn' }, t('tagMissing')),
            replies.length > 0 && h('span', {}, plural(t, replies.length, 'repliesOne', 'repliesMany'))
          )
        )
      )
    )
  }

  function renderList(): void {
    list.hidden = !listOpen
    if (!listOpen) return
    const counts = {
      open: threads.filter((thread) => thread.comment.version === version && thread.comment.status === 'open').length,
      resolved: threads.filter((thread) => thread.comment.version === version && thread.comment.status === 'resolved')
        .length,
    }
    const { here, elsewhere } = listThreads(threads, version, listFilter)
    const tab = (value: ListFilter, label: string) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tab',
          'aria-pressed': String(listFilter === value),
          onclick: () => {
            listFilter = value
            refresh()
          },
        },
        label,
        h('span', { class: 'tab-count' }, String(counts[value]))
      )
    const body = h('div', { class: 'list-body' })
    if (failed) body.append(h('p', { class: 'list-empty is-error' }, t('listLoadFailed')))
    else if (here.length) body.append(h('ul', { class: 'items' }, here.map(listItem)))
    else if (loaded)
      body.append(
        h(
          'p',
          { class: 'list-empty' },
          listFilter === 'resolved' ? t('listEmptyResolved') : canComment ? t('listEmptyOpen') : t('listEmptyOpenOff')
        )
      )
    if (elsewhere.length) {
      const newer = elsewhere.some((thread) => thread.comment.version > version)
      body.append(
        h('h3', { class: 'list-section' }, newer ? t('listOther') : t('listEarlier')),
        h('ul', { class: 'items' }, elsewhere.map(listItem))
      )
    }
    list.replaceChildren(
      h(
        'header',
        { class: 'list-head' },
        h('h2', {}, t('listTitle')),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('listClose'),
            title: t('listClose'),
            onclick: () => controller.setList(false),
          },
          icon('close', 15)
        )
      ),
      h(
        'div',
        { class: 'tabs', role: 'group', 'aria-label': t('listGroup') },
        tab('open', t('listOpen')),
        tab('resolved', t('listResolved'))
      ),
      body,
      !canComment
        ? h('p', { class: 'list-foot is-note' }, t('commentsOff'))
        : h(
            'footer',
            { class: 'list-foot' },
            h(
              'button',
              { type: 'button', class: 'button', onclick: () => startDraft(null) },
              icon('comment', 14),
              t('pageComment')
            )
          )
    )
  }

  // --- The comment-mode hint.

  function renderHint(): void {
    float.querySelector('.hint')?.remove()
    if (!commenting) return
    float.append(
      h(
        'div',
        { class: 'hint', role: 'status' },
        h('span', {}, t('commentHint')),
        h(
          'button',
          { type: 'button', class: 'hint-exit', onclick: () => controller.setCommenting(false) },
          t('commentHintExit'),
          h('kbd', {}, 'Esc')
        )
      )
    )
  }

  function refresh(): void {
    options.onChange()
    renderPins()
    sendAnchors()
    renderCard()
    renderList()
  }

  // --- Keeping current: other people comment too.

  let polling: ReturnType<typeof setInterval> | null = null
  const busyTyping = () => Boolean(draft || replyText.trim())
  function poll(): void {
    if (document.visibilityState === 'visible' && !busyTyping()) void load()
  }
  polling = setInterval(poll, REFRESH_MS)
  document.addEventListener('visibilitychange', poll)
  void load()

  const controller: CommentsController = {
    get commenting() {
      return commenting
    },
    get listOpen() {
      return listOpen
    },
    openCounts: () => openCounts(threads),

    setCommenting(on) {
      if (on && !canComment) return
      commenting = on
      if (!on && draft?.anchor) cancelDraft()
      stage.classList.toggle('is-commenting', on)
      toPage({ type: 'mode', commenting: on })
      renderHint()
      placeSelection()
      options.onChange()
    },

    setList(open) {
      listOpen = open
      if (open && !loaded) void load()
      refresh()
    },

    setVersion(next) {
      if (next === version) return
      version = next
      positions = {}
      selection = null
      draft = null
      activeId = null
      pendingReveal = null
      edgesKey = ''
      refresh()
    },

    handle(message) {
      if (message.type === 'ready') {
        toPage({ type: 'mode', commenting })
        sendAnchors()
        if (pendingReveal) toPage({ type: 'reveal', id: pendingReveal })
        pendingReveal = null
      } else if (message.type === 'layout') {
        const missingBefore = Object.keys(positions)
          .filter((id) => positions[id] === null)
          .join()
        positions = message.pins
        frameSize = { width: message.width, height: message.height }
        placeAll()
        // Whether a passage is missing shows in the card and the list; they change only when that does.
        if (
          missingBefore !==
          Object.keys(positions)
            .filter((id) => positions[id] === null)
            .join()
        ) {
          renderCard()
          renderList()
        }
      } else if (message.type === 'selection') {
        selection = message.quote && message.rect ? { quote: message.quote, rect: message.rect } : null
        placeSelection()
      } else if (message.type === 'pick') {
        if (commenting) startDraft(message.anchor)
      } else if (message.type === 'pointer') {
        if (activeId && !commenting) closeThread()
      }
    },

    escape() {
      if (draft) cancelDraft()
      else if (activeId) closeThread()
      else if (commenting) controller.setCommenting(false)
      else return false
      return true
    },

    relayout() {
      toPage({ type: 'measure' })
      placeAll()
    },
  }

  window.addEventListener('pagehide', () => {
    if (polling) clearInterval(polling)
  })
  return controller
}
