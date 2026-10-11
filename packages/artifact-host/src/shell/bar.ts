// The viewer's top bar: what the page is, which version is on screen, how to comment, and who is looking.
import { avatar } from './avatar.js'
import { relativeTime } from './comments-model.js'
import type { ViewerIdentity, ViewerSharing, ViewerState } from './contract.js'
import { copyText, h, put, toast } from './dom.js'
import { plural, type Translate } from './i18n.js'
import { icon } from './icons.js'
import { createListbox } from './listbox.js'
import { closePopover, togglePopover } from './popover.js'

export type Viewport = 'desktop' | 'tablet' | 'phone'
export const VIEWPORTS: readonly Viewport[] = ['desktop', 'tablet', 'phone']

export interface BarOptions {
  t: Translate
  locale: string
  state: ViewerState
  /** False for previews, which show the page alone. */
  comments: boolean
  onVersion(version: number): void
  onViewport(viewport: Viewport): void
  onToggleCommenting(): void
  onToggleList(): void
  onReload(): void
  onFullScreen(): void
  onCopyVersionLink(): void
  onLeave(): void
}

export interface BarModel {
  version: number
  viewport: Viewport
  commenting: boolean
  listOpen: boolean
  openCounts: ReadonlyMap<number, number>
}

const iconButton = (name: Parameters<typeof icon>[0], label: string, props: Record<string, string> = {}) => {
  const { class: extra, ...rest } = props
  return h(
    'button',
    { type: 'button', class: `button icon${extra ? ` ${extra}` : ''}`, 'aria-label': label, title: label, ...rest },
    icon(name, 16)
  )
}

/** Who the viewer is, as the avatar button says it. */
export function identityLabel(t: Translate, state: ViewerState): string {
  const { identity } = state
  const owner = state.ownerName || t('theOwner')
  if (identity.kind === 'owner')
    return state.ownerName ? t('identityOwner', { name: state.ownerName }) : t('identityOwnerUnnamed')
  if (identity.kind === 'guest')
    return identity.name ? t('identityGuest', { name: identity.name }) : t('identityGuestUnnamed')
  return t(identity.kind === 'invited' ? 'identityInvited' : 'identityApproved', { name: identity.name, owner })
}

const faceOf = (state: ViewerState, size: number): HTMLElement => {
  const { identity } = state
  if (identity.kind === 'owner') return avatar('owner', state.ownerName, size)
  return avatar(identity.kind, identity.name ?? '', size)
}

export function createBar(options: BarOptions): { root: HTMLElement; update(model: BarModel): void } {
  const { t, locale, state } = options
  const { artifact } = state
  const total = artifact.currentVersion
  const isOwner = state.identity.kind === 'owner'
  let model: BarModel | null = null
  const when = (at: number) => relativeTime(locale, at, Date.now(), t('now'))

  // What the page is.
  const title = h('h1', { class: 'doc-title', title: artifact.title }, artifact.title)
  const meta = h('p', { class: 'doc-meta' })
  const doc = h(
    'div',
    { class: 'doc' },
    h('span', { class: 'doc-mark' }, icon('artifact', 15)),
    h('div', { class: 'doc-text' }, title, meta)
  )

  // Which version: step back and forth, or choose from the list.
  const previous = iconButton('left', t('versionPrevious'), { class: 'version-step' })
  const following = iconButton('right', t('versionNext'), { class: 'version-step' })
  previous.addEventListener('click', () => model && options.onVersion(model.version - 1))
  following.addEventListener('click', () => model && options.onVersion(model.version + 1))
  const versions = createListbox({
    label: t('versionList'),
    className: 'version-current',
    trigger: (item) => [
      h('span', { class: 'version-number' }, item?.badge ?? ''),
      h(
        'span',
        { class: 'version-tag' },
        item?.value === String(total) ? t('versionCurrent') : t('versionOf', { total })
      ),
    ],
    triggerLabel: (item) => t('versionTrigger', { n: item?.value ?? '', total }),
    onChange: (value) => options.onVersion(Number(value)),
  })
  const version = h(
    'div',
    { class: 'version', role: 'group', 'aria-label': t('versionGroup') },
    previous,
    versions.button,
    following
  )

  // How wide the page is drawn.
  const widths = VIEWPORTS.map((viewport) => {
    const label = t(viewport === 'desktop' ? 'widthDesktop' : viewport === 'tablet' ? 'widthTablet' : 'widthPhone')
    return h(
      'button',
      {
        type: 'button',
        class: 'segment-item',
        'aria-label': label,
        title: label,
        'aria-pressed': 'false',
        onclick: () => options.onViewport(viewport),
      },
      icon(viewport, 15)
    )
  })
  const segment = h('div', { class: 'segment', role: 'group', 'aria-label': t('widthGroup') }, widths)

  // Comment mode, and the list of comments, in one control.
  const commentButton = h(
    'button',
    {
      type: 'button',
      class: 'button comment-button',
      'aria-pressed': 'false',
      title: state.can.comment ? t('commentModeTitle') : t('commentsOff'),
      disabled: !state.can.comment,
      onclick: options.onToggleCommenting,
    },
    icon('comment', 15),
    h('span', { class: 'button-label' }, t('commentMode')),
    h('kbd', {}, 'C')
  )
  const count = h('span', { class: 'count' })
  const listButton = h(
    'button',
    { type: 'button', class: 'button list-button', 'aria-pressed': 'false', onclick: options.onToggleList },
    icon('panel', 15),
    count
  )
  const comments = options.comments && h('div', { class: 'joined' }, commentButton, listButton)

  // Who can open the page, for the owner. Changing it happens in Maestrly.
  const share =
    isOwner &&
    state.sharing &&
    h(
      'button',
      { type: 'button', class: 'button share-button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
      icon('link', 15),
      h('span', { class: 'button-label' }, t('share'))
    )
  if (share && state.sharing) {
    const sharing = state.sharing
    share.addEventListener('click', () => togglePopover(share, 'share', (el) => buildShare(el, t, locale, sharing)))
  }

  const more = iconButton('more', t('more'), { 'aria-haspopup': 'menu', 'aria-expanded': 'false' })
  more.addEventListener('click', () =>
    togglePopover(more, 'actions', (el) => {
      el.setAttribute('role', 'menu')
      const item = (name: Parameters<typeof icon>[0], label: string, run: () => void, key?: string) =>
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item',
            role: 'menuitem',
            onclick: () => {
              closePopover()
              run()
            },
          },
          icon(name, 15),
          h('span', {}, label),
          key && h('kbd', {}, key)
        )
      put(
        el,
        item('reload', t('reloadPage'), options.onReload),
        item('full', t('fullScreen'), options.onFullScreen, 'F'),
        item('copy', t('copyVersionLink'), options.onCopyVersionLink)
      )
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault()
        const items = [...el.querySelectorAll<HTMLElement>('.menu-item')]
        const at = items.indexOf(document.activeElement as HTMLElement)
        items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      })
      return undefined
    })
  )

  // Who you are here.
  const identity = h('button', {
    type: 'button',
    class: 'identity',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
  })
  identity.addEventListener('click', () =>
    togglePopover(identity, 'who', (el) => {
      el.setAttribute('role', 'dialog')
      el.setAttribute('aria-label', identityLabel(t, state))
      put(
        el,
        h(
          'div',
          { class: 'who-head' },
          faceOf(state, 36),
          h('div', {}, h('b', {}, nameOf(state, t)), h('p', {}, whoDetail(state, t)))
        ),
        !isOwner && h('p', { class: 'popover-text' }, t('stored')),
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item',
            onclick: () => {
              closePopover(false)
              options.onLeave()
            },
          },
          icon('leave', 15),
          h('span', {}, t('leaveDevice'))
        )
      )
      return undefined
    })
  )

  const root = h(
    'header',
    { class: 'bar' },
    doc,
    version,
    h('div', { class: 'tools' }, options.comments && segment, comments, share, more, identity)
  )

  return {
    root,
    update(view) {
      model = view
      const current = artifact.versions.find((item) => item.number === artifact.currentVersion)
      const updated = when(current?.createdAt ?? Date.now())
      meta.textContent = isOwner
        ? t('metaOwner', { when: updated })
        : state.ownerName
          ? t('metaFrom', { owner: state.ownerName, when: updated })
          : t('metaUpdated', { when: updated })

      versions.update(
        [...artifact.versions]
          .sort((a, b) => b.number - a.number)
          .map((item) => {
            const open = view.openCounts.get(item.number) ?? 0
            return {
              value: String(item.number),
              badge: `v${item.number}`,
              label: item.summary || (item.number === 1 ? t('versionFirst') : t('versionNoSummary')),
              tag: item.number === total ? t('versionCurrent') : undefined,
              meta: [when(item.createdAt), open ? plural(t, open, 'versionOpenOne', 'versionOpenMany') : '']
                .filter(Boolean)
                .join(' · '),
            }
          }),
        String(view.version)
      )
      previous.disabled = view.version <= 1
      following.disabled = view.version >= total

      for (const [index, button] of widths.entries())
        button.setAttribute('aria-pressed', String(VIEWPORTS[index] === view.viewport))
      commentButton.setAttribute('aria-pressed', String(view.commenting))
      listButton.setAttribute('aria-pressed', String(view.listOpen))
      const open = view.openCounts.get(view.version) ?? 0
      count.textContent = String(open)
      const listLabel = t(view.listOpen ? 'listHide' : 'listShow', { n: open })
      listButton.setAttribute('aria-label', listLabel)
      listButton.title = listLabel

      identity.replaceChildren(faceOf(state, 28))
      identity.setAttribute('aria-label', identityLabel(t, state))
      identity.title = identityLabel(t, state)
    },
  }
}

function nameOf(state: ViewerState, t: Translate): string {
  const { identity } = state
  if (identity.kind === 'owner') return state.ownerName || t('whoOwner')
  return identity.name || t('guest')
}

function whoDetail(state: ViewerState, t: Translate): string {
  const identity: ViewerIdentity = state.identity
  const owner = state.ownerName || t('theOwner')
  if (identity.kind === 'owner') return t('whoOwner')
  if (identity.kind === 'guest') return t('whoGuest')
  return t(identity.kind === 'invited' ? 'whoInvited' : 'whoApproved', { owner })
}

function buildShare(el: HTMLElement, t: Translate, locale: string, sharing: ViewerSharing): HTMLElement | undefined {
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', t('share'))
  const date = (at: number) =>
    new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(at)
  const heading =
    sharing.visibility === 'private' ? 'sharePrivate' : sharing.visibility === 'people' ? 'sharePeople' : 'shareLink'
  const detail =
    sharing.visibility === 'private'
      ? t('sharePrivateText')
      : sharing.visibility === 'people'
        ? t('sharePeopleText')
        : sharing.linkExpiresAt
          ? t('shareLinkUntil', { date: date(sharing.linkExpiresAt) })
          : t('shareLinkText')
  let focus: HTMLElement | undefined
  put(el, h('p', { class: 'popover-title' }, t(heading)), h('p', { class: 'popover-text' }, detail))

  if (sharing.visibility !== 'private') {
    const input = h('input', {
      class: 'input mono',
      readonly: true,
      value: sharing.link,
      'aria-label': t('shareLinkLabel'),
    })
    input.addEventListener('focus', () => input.select())
    const copy = h(
      'button',
      {
        type: 'button',
        class: 'button primary',
        onclick: async () => {
          const copied = await copyText(sharing.link)
          if (!copied) return input.select()
          closePopover()
          toast(t('shareCopied'))
        },
      },
      icon('copy', 14),
      t('shareCopy')
    )
    focus = copy
    put(
      el,
      h('div', { class: 'field-row' }, input, copy),
      sharing.local && h('p', { class: 'popover-warn' }, t('shareLocal'))
    )
  }

  if (sharing.peopleCount || sharing.requests) {
    const list = h('ul', { class: 'people' })
    for (const person of sharing.people) {
      const kind =
        person.kind === 'invited'
          ? t('shareInvited')
          : person.kind === 'approved'
            ? t('shareApproved')
            : t('shareGuest')
      const devices = person.devices
        ? plural(t, person.devices, 'shareDevicesOne', 'shareDevicesMany')
        : t('shareDevicesNone')
      list.append(
        h(
          'li',
          {},
          avatar(person.kind, person.name, 26),
          h(
            'span',
            { class: 'people-text' },
            h('b', {}, person.name || t('shareGuestUnnamed')),
            h('span', {}, `${kind} · ${devices}`)
          )
        )
      )
    }
    const rest = sharing.peopleCount - sharing.people.length
    if (rest > 0) list.append(h('li', { class: 'people-more' }, t('shareMorePeople', { n: rest })))
    if (sharing.requests)
      list.append(
        h(
          'li',
          { class: 'is-request' },
          h('span', { class: 'request-dot', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'people-text' },
            h('b', {}, plural(t, sharing.requests, 'shareRequestsOne', 'shareRequestsMany')),
            h('span', {}, t('shareRequestsHint'))
          )
        )
      )
    el.append(list)
  }
  el.append(h('p', { class: 'popover-foot' }, t('shareManage')))
  return focus
}
