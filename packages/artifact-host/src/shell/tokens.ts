// Tokens side panel (grouped editors, theme tabs, search filter, pending changes tray) and the Save / Apply modal.
import type { ViewerState } from './contract.js'
import {
  type DescribedTokenChange,
  describeDraftChanges,
  formatChangeName,
  formatTokenSummary,
  inheritedTokenCount,
  parseThemeSelector,
  splitTokenSummaryParts,
  stepNumericToken,
  TOKEN_GROUP_KEY,
  TOKEN_GROUPS,
  type ThemeTokenEntry,
  themeDisplayName,
  tokenKey,
  tokensForTheme,
  tokenValuesEqual,
} from './design-ui-model.js'
import {
  canSaveTokens,
  canSuggestTokens,
  type DesignController,
  type DesignSnapshot,
  isValidTokenValue,
  type TokenGroup,
  type TokenValueKind,
} from './design-ui-stub.js'
import { h, put, toast } from './dom.js'
import { plural, type Translate } from './i18n.js'
import { icon } from './icons.js'
import { changeLabelElement, changeValuesElement, displayTokenValue, resolveColorHex } from './suggestion-ui.js'

const SKELETON_WIDTHS = [62, 48, 70, 55, 40, 66, 50, 58] as const

function isValidCssForKind(kind: TokenValueKind, value: string): boolean {
  if (!isValidTokenValue(value)) return false
  if (kind === 'number') return /^-?\d*\.?\d+$/.test(value)
  if (typeof CSS === 'undefined') return true
  if (kind === 'color') return CSS.supports('color', value)
  if (kind === 'length') {
    return /m?s$/.test(value) && !/px$/.test(value)
      ? CSS.supports('transition-duration', value)
      : CSS.supports('width', value)
  }
  return true
}

export interface TokensPanelOptions {
  t: Translate
  state: ViewerState
  controller: DesignController
  side: HTMLElement
  /** Called when the owner clicks Save as version N. */
  onRequestSave(): void
  /** Called when a non-owner clicks Suggest. */
  onRequestSuggest(): void
  /** Optional retry hook when loading `GET design` fails. */
  onRetryLoad?: () => void
}

export interface TokensPanel {
  render(snapshot: DesignSnapshot, loadError?: boolean): void
  /** Opens the right theme, clears filter, scrolls to `name`, flashes the row, and focuses its input. */
  focusToken(name: string): void
  destroy(): void
}

interface RowHandle {
  el: HTMLElement
  input: HTMLInputElement
  picker: HTMLInputElement | null
  chip: HTMLElement | null
  error: HTMLElement
  token: ThemeTokenEntry
}

interface BuiltPanel {
  version: number
  theme: string | null
  tokenCount: number
  rows: Map<string, RowHandle>
  groups: Map<TokenGroup, { el: HTMLElement; setOpen(open: boolean): void }>
  filter: HTMLInputElement
  empty: HTMLElement
  tray: HTMLElement
  foot: HTMLElement
  tabs: HTMLElement
}

export function createTokensPanel(options: TokensPanelOptions): TokensPanel {
  const { t, state, controller, side } = options
  const owner = state.ownerName || t('theOwner')
  const isOwner = state.identity.kind === 'owner'
  let filterQuery = ''
  let trayOpen = true
  let built: BuiltPanel | null = null
  let flashTimer: ReturnType<typeof setTimeout> | null = null

  function tokensFile(snapshot: DesignSnapshot): string {
    return snapshot.design?.tokenFile ?? 'tokens.css'
  }

  function buildHead(snapshot: DesignSnapshot): HTMLElement {
    const ready = !snapshot.loading && Boolean(snapshot.design)
    return h(
      'header',
      { class: 'side-head' },
      h('span', { class: 'side-mark is-tokens' }, icon('tokens', 16)),
      h(
        'div',
        { class: 'side-title' },
        h('h2', {}, t('tokensPanel')),
        h(
          'p',
          { class: 'side-sub' },
          ready && snapshot.design
            ? t('tokensFile', { file: tokensFile(snapshot), n: snapshot.design.tokens.length })
            : tokensFile(snapshot)
        )
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': t('tokensClose'),
          title: t('tokensClose'),
          onclick: () => controller.setTokensOpen(false),
        },
        icon('close', 15)
      )
    )
  }

  function buildThemeTabs(snapshot: DesignSnapshot): HTMLElement | null {
    const design = snapshot.design
    if (!design || design.themes.length === 0) return null
    const allThemes: (string | null)[] = [null, ...design.themes]
    const pendingThemes = new Set(snapshot.draftChanges.map((change) => change.theme ?? null))
    return h(
      'div',
      { class: 'tabs theme-tabs', role: 'group', 'aria-label': t('themeGroup') },
      allThemes.map((selector) => {
        const meta = parseThemeSelector(selector)
        const count = tokensForTheme(design, selector).length
        return h(
          'button',
          {
            type: 'button',
            class: 'tab',
            'aria-pressed': String(snapshot.activeTheme === selector),
            title: meta.system ? t('themeSystemHint') : undefined,
            onclick: () => {
              const fromTabs = document.activeElement?.closest?.('.theme-tabs') !== null
              filterQuery = ''
              controller.setActiveTheme(selector)
              if (fromTabs) built?.tabs.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
            },
          },
          themeDisplayName(t, selector),
          h('span', { class: 'tab-count' }, String(count)),
          pendingThemes.has(selector) && h('span', { class: 'theme-dot', role: 'img', 'aria-label': t('themePending') })
        )
      })
    )
  }

  function applyFilter(): void {
    if (!built) return
    const query = filterQuery.trim().toLowerCase()
    let shown = 0
    for (const [group, entry] of built.groups) {
      let visible = 0
      for (const row of built.rows.values()) {
        if (row.token.group !== group) continue
        const match =
          !query || row.token.name.toLowerCase().includes(query) || row.input.value.toLowerCase().includes(query)
        row.el.hidden = !match
        if (match) visible += 1
      }
      entry.el.hidden = visible === 0
      shown += visible
    }
    built.empty.hidden = shown > 0
    built.empty.textContent = t('tokensFilterEmpty', { query: filterQuery.trim() })
  }

  function handleTokenInput(entry: ThemeTokenEntry, raw: string): void {
    const value = raw.trim()
    const row = built?.rows.get(entry.key)
    const valid = isValidCssForKind(entry.kind, value)
    if (row) {
      row.el.classList.toggle('is-invalid', !valid)
      row.error.hidden = valid
      row.input.setAttribute('aria-invalid', String(!valid))
    }
    if (!valid) return
    if (tokenValuesEqual(entry.kind, value, entry.baseValue)) {
      controller.resetToken(entry.name, entry.theme)
    } else {
      controller.setTokenValue(entry.name, value, entry.theme)
    }
  }

  function resetRow(entry: ThemeTokenEntry): void {
    controller.resetToken(entry.name, entry.theme)
    const row = built?.rows.get(entry.key)
    if (row) {
      row.input.value = displayTokenValue(entry.baseValue, entry.kind)
      row.el.classList.remove('is-invalid')
      row.error.hidden = true
      row.input.setAttribute('aria-invalid', 'false')
    }
  }

  function buildPanel(snapshot: DesignSnapshot): void {
    const design = snapshot.design!
    const rows = new Map<string, RowHandle>()
    const groups = new Map<TokenGroup, { el: HTMLElement; setOpen(open: boolean): void }>()
    const filter = h('input', {
      class: 'input',
      type: 'search',
      placeholder: t('tokensFilter'),
      'aria-label': t('tokensFilter'),
      value: filterQuery,
    })
    filter.addEventListener('input', () => {
      filterQuery = filter.value
      applyFilter()
    })

    const body = h('div', { class: 'side-body' })
    const empty = h('p', { class: 'list-empty', hidden: true })
    const inView = tokensForTheme(design, snapshot.activeTheme)
    let sequence = 0

    for (const group of TOKEN_GROUPS) {
      const groupEntries = inView.filter((item) => item.group === group)
      if (!groupEntries.length) continue
      const listId = `tokens-${group}`
      const itemsEl = h('ul', { class: 'token-list', id: listId })
      const head = h(
        'button',
        { type: 'button', class: 'token-group-head', 'aria-expanded': 'true', 'aria-controls': listId },
        icon('down', 14),
        t(TOKEN_GROUP_KEY[group]),
        h('span', { class: 'tab-count' }, String(groupEntries.length))
      )
      const setOpen = (open: boolean) => {
        head.setAttribute('aria-expanded', String(open))
        itemsEl.hidden = !open
      }
      head.addEventListener('click', () => setOpen(head.getAttribute('aria-expanded') !== 'true'))
      const groupEl = h('section', { class: 'token-group' }, head, itemsEl)
      groups.set(group, { el: groupEl, setOpen })

      for (const entry of groupEntries) {
        const id = `token-${++sequence}`
        const input = h('input', {
          id,
          class: 'token-input',
          spellcheck: 'false',
          autocomplete: 'off',
          maxlength: '200',
          'aria-describedby': `${id}-error`,
        })
        input.value = displayTokenValue(entry.baseValue, entry.kind)
        const field = h('div', { class: `token-field${entry.kind === 'color' ? ' has-swatch' : ''}` })
        let picker: HTMLInputElement | null = null
        let chip: HTMLElement | null = null
        if (entry.kind === 'color') {
          picker = h('input', { type: 'color', tabindex: '-1', 'aria-label': t('tokenPick', { name: entry.name }) })
          chip = h('label', { class: 'token-swatch', title: t('tokenPick', { name: entry.name }) }, picker)
          picker.addEventListener('input', () => {
            input.value = picker!.value.toUpperCase()
            handleTokenInput(entry, input.value)
          })
          field.append(chip)
        }
        field.append(input)
        const error = h('p', { class: 'token-error', id: `${id}-error`, hidden: true }, t('tokenInvalid'))
        const reset = h(
          'button',
          {
            type: 'button',
            class: 'icon-button token-reset',
            'aria-label': t('tokenReset', { name: entry.name }),
            title: t('tokenReset', { name: entry.name }),
            onclick: () => resetRow(entry),
          },
          icon('reset', 13)
        )
        const rowEl = h(
          'li',
          { class: `token-row is-${entry.kind}`, 'data-token': entry.key },
          h('label', { class: 'token-name', for: id, title: entry.name }, entry.name),
          field,
          reset,
          error
        )
        let before = ''
        input.addEventListener('focus', () => {
          before = input.value
        })
        input.addEventListener('input', () => handleTokenInput(entry, input.value))
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            input.value = before
            handleTokenInput(entry, before)
            input.blur()
          } else if (event.key === 'Enter') {
            input.blur()
          } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && entry.kind !== 'text') {
            const stepped = stepNumericToken(input.value, event.key === 'ArrowUp' ? 1 : -1, event.shiftKey)
            if (!stepped) return
            event.preventDefault()
            input.value = stepped
            handleTokenInput(entry, stepped)
          }
        })
        rows.set(entry.key, { el: rowEl, input, picker, chip, error, token: entry })
        itemsEl.append(rowEl)
      }
      body.append(groupEl)
    }

    body.append(empty)
    const inherited = inheritedTokenCount(design, snapshot.activeTheme)
    if (inherited > 0) {
      body.append(
        h(
          'p',
          { class: 'tokens-inherit' },
          t('themeInherit', { n: inherited, theme: t('themeDefault') }),
          ' ',
          h(
            'button',
            { type: 'button', class: 'link', onclick: () => controller.setActiveTheme(null) },
            t('themeShow', { theme: t('themeDefault') })
          )
        )
      )
    }

    const tray = h('footer', { class: 'tray' })
    const foot = h('p', { class: 'side-foot' })
    const tabs = buildThemeTabs(snapshot) ?? h('span', { hidden: true })
    side.replaceChildren(
      buildHead(snapshot),
      tabs,
      h('div', { class: 'tokens-filter' }, icon('search', 14), filter),
      body,
      tray,
      foot
    )
    built = {
      version: snapshot.version,
      theme: snapshot.activeTheme,
      tokenCount: design.tokens.length,
      rows,
      groups,
      filter,
      empty,
      tray,
      foot,
      tabs,
    }
    applyFilter()
  }

  function updatePanel(snapshot: DesignSnapshot): void {
    if (!built) return
    const draftMap = new Map(snapshot.draftChanges.map((change) => [tokenKey(change.name, change.theme), change.value]))
    for (const row of built.rows.values()) {
      const changed = draftMap.has(row.token.key)
      const value = draftMap.get(row.token.key) ?? row.token.baseValue
      row.el.classList.toggle('is-changed', changed)
      if (document.activeElement !== row.input && !row.el.classList.contains('is-invalid')) {
        row.input.value = displayTokenValue(value, row.token.kind)
      }
      if (row.chip && row.picker) {
        row.chip.style.setProperty('--swatch', value)
        const hex = resolveColorHex(value)
        if (hex) row.picker.value = hex.toLowerCase()
      }
    }

    const tabs = buildThemeTabs(snapshot)
    if (tabs) {
      built.tabs.replaceWith(tabs)
      built.tabs = tabs
    }

    const changes = describeDraftChanges(snapshot.design, snapshot.draftChanges)
    const { tray, foot } = built
    tray.hidden = changes.length === 0
    foot.hidden = changes.length > 0
    foot.textContent = isOwner
      ? t('tokensFootOwner')
      : state.can.comment
        ? t('tokensFootGuest', { owner })
        : t('tokensFootReadonly')
    if (!changes.length) {
      tray.replaceChildren()
      return
    }

    const behind = snapshot.version !== state.artifact.currentVersion
    const maySave = canSaveTokens(state, snapshot.version, snapshot.design)
    const maySuggest = canSuggestTokens(state, snapshot.design)
    const primary = isOwner
      ? h(
          'button',
          {
            type: 'button',
            class: 'button primary',
            disabled: !maySave,
            onclick: () => options.onRequestSave(),
          },
          t('saveAs', { n: state.artifact.currentVersion + 1 })
        )
      : maySuggest &&
        h(
          'button',
          { type: 'button', class: 'button primary', onclick: () => options.onRequestSuggest() },
          icon('comment', 14),
          t('suggest')
        )

    tray.setAttribute('aria-label', plural(t, changes.length, 'changesOne', 'changesMany'))
    tray.replaceChildren()
    put(
      tray,
      h(
        'div',
        { class: 'tray-head' },
        h('b', {}, plural(t, changes.length, 'changesOne', 'changesMany')),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-expanded': String(trayOpen),
            'aria-label': trayOpen ? t('changesHide') : t('changesShow'),
            title: trayOpen ? t('changesHide') : t('changesShow'),
            onclick: () => {
              trayOpen = !trayOpen
              updatePanel(controller.snapshot())
            },
          },
          icon(trayOpen ? 'down' : 'up', 15)
        )
      ),
      trayOpen &&
        h(
          'ul',
          { class: 'change-list' },
          changes.map((change) =>
            h(
              'li',
              { class: 'change' },
              changeLabelElement(t, change),
              changeValuesElement(change),
              h(
                'button',
                {
                  type: 'button',
                  class: 'icon-button token-reset',
                  'aria-label': t('tokenReset', { name: formatChangeName(t, change.name, change.theme) }),
                  title: t('tokenReset', { name: formatChangeName(t, change.name, change.theme) }),
                  onclick: () => {
                    controller.resetToken(change.name, change.theme)
                    const row = built?.rows.get(change.key)
                    if (row) {
                      row.el.classList.remove('is-invalid')
                      row.error.hidden = true
                    }
                  },
                },
                icon('reset', 13)
              )
            )
          )
        ),
      h(
        'p',
        { class: 'tray-note' },
        behind && isOwner
          ? t('changesOldVersion')
          : isOwner
            ? t('changesPreview')
            : state.can.comment
              ? t('changesPreviewGuest', { owner })
              : t('changesPreviewReadonly')
      ),
      h(
        'div',
        { class: 'tray-actions' },
        h('button', { type: 'button', class: 'button', onclick: () => controller.discardTokens() }, t('discard')),
        primary
      )
    )
  }

  function render(snapshot: DesignSnapshot, loadError = false): void {
    if (!snapshot.tokensOpen) {
      if (side.classList.contains('tokens-panel')) {
        side.hidden = true
        side.className = 'side'
        side.replaceChildren()
      }
      built = null
      return
    }

    side.hidden = false
    side.className = 'side tokens-panel'
    side.setAttribute('aria-label', t('tokensPanel'))

    if (snapshot.loading) {
      built = null
      side.replaceChildren(
        buildHead(snapshot),
        h(
          'div',
          { class: 'side-body' },
          h(
            'div',
            { class: 'tokens-state', role: 'status', 'aria-label': t('tokensLoading') },
            SKELETON_WIDTHS.map((width) =>
              h(
                'div',
                { class: 'skeleton-row' },
                h('span', { class: 'skeleton', style: `width:${width}%` }),
                h('span', { class: 'skeleton' })
              )
            )
          )
        )
      )
      return
    }

    if (loadError || !snapshot.design) {
      built = null
      side.replaceChildren(
        buildHead(snapshot),
        h(
          'div',
          { class: 'side-body' },
          h(
            'div',
            { class: 'tokens-state' },
            h('p', { class: 'list-empty is-error', role: 'alert' }, t('tokensFailed')),
            options.onRetryLoad &&
              h('button', { type: 'button', class: 'button', onclick: () => options.onRetryLoad?.() }, t('retry'))
          )
        )
      )
      return
    }

    if (snapshot.design.tokens.length === 0) {
      built = null
      side.replaceChildren(
        buildHead(snapshot),
        h(
          'div',
          { class: 'side-body' },
          h(
            'div',
            { class: 'tokens-state' },
            h('p', { class: 'list-empty' }, t('tokensEmpty', { file: tokensFile(snapshot) }))
          )
        )
      )
      return
    }

    if (
      !built ||
      built.version !== snapshot.version ||
      built.theme !== snapshot.activeTheme ||
      built.tokenCount !== snapshot.design.tokens.length
    ) {
      buildPanel(snapshot)
    }
    updatePanel(snapshot)
  }

  return {
    render,
    focusToken(name) {
      const snapshot = controller.snapshot()
      const design = snapshot.design
      if (!design) return
      const found = design.tokens.find((item) => item.name === name)
      const targetTheme =
        snapshot.activeTheme && found && Object.hasOwn(found.themes, snapshot.activeTheme) ? snapshot.activeTheme : null
      if (snapshot.activeTheme !== targetTheme) controller.setActiveTheme(targetTheme)
      if (!snapshot.tokensOpen) controller.setTokensOpen(true)
      filterQuery = ''
      render(controller.snapshot())
      if (!built) return
      built.filter.value = ''
      applyFilter()
      const row = built.rows.get(tokenKey(name, targetTheme))
      if (!row) return
      built.groups.get(row.token.group)?.setOpen(true)
      row.el.scrollIntoView({ block: 'center' })
      row.el.classList.remove('is-flash')
      void row.el.offsetWidth
      row.el.classList.add('is-flash')
      if (flashTimer !== null) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => row.el.classList.remove('is-flash'), 1600)
      row.input.focus()
      row.input.select()
    },
    destroy() {
      if (flashTimer !== null) clearTimeout(flashTimer)
      built = null
      if (side.classList.contains('tokens-panel')) {
        side.hidden = true
        side.className = 'side'
        side.replaceChildren()
      }
    },
  }
}

// --- Save / Apply confirmation modal ---

export type TokenSaveDialogStatus = 'idle' | 'saving' | 'conflict' | 'stale' | 'failed'

export interface TokenSaveDialogOptions {
  t: Translate
  kind: 'save' | 'apply'
  nextVersion: number
  tokenFile: string
  changes: readonly DescribedTokenChange[]
  /** Required when `kind === 'apply'`. */
  authorName?: string
  /** Runs the save/apply request; returns the resulting dialog status or `'done'` to close. */
  onConfirm(): Promise<
    | { outcome: 'done'; savedVersion: number }
    | { outcome: 'conflict'; currentVersion: number }
    | { outcome: 'stale'; staleNames?: string[] }
    | { outcome: 'failed' }
  >
  /** Called when the user clicks "Load version N" after a conflict. */
  onRebase?: (currentVersion: number) => Promise<void> | void
  /** Called when the user clicks "Edit in Tokens" after a stale suggestion failure. */
  onEditInTokens?: () => void
  onClose?: () => void
}

export interface TokenSaveDialog {
  close(): void
}

/** Opens the modal confirming saving token changes (or applying a suggestion) as a new version. */
export function openTokenSaveDialog(options: TokenSaveDialogOptions): TokenSaveDialog {
  const { t, kind, tokenFile, changes, authorName } = options
  const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let status: TokenSaveDialogStatus = 'idle'
  let conflictVersion = options.nextVersion
  let staleNames: string[] = []
  let dialogEl: HTMLDialogElement | null = null

  function close(): void {
    if (dialogEl?.open) dialogEl.close()
    dialogEl?.remove()
    dialogEl = null
    returnFocusTo?.focus()
    options.onClose?.()
  }

  function render(): void {
    const n = options.nextVersion
    const summary = formatTokenSummary(t, changes, kind === 'apply' ? authorName : undefined)
    const confirmButton = h(
      'button',
      { type: 'submit', class: 'button primary', disabled: status === 'saving' },
      status === 'saving' && h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      status === 'stale' && icon('tokens', 14),
      status === 'saving'
        ? t('saving')
        : status === 'conflict'
          ? t('saveConflictAction', { n: conflictVersion })
          : status === 'stale'
            ? t('suggestionEdit')
            : t('saveConfirm', { n })
    )

    const summaryParts = splitTokenSummaryParts(t('saveSummary', { summary }))
    const form = h(
      'form',
      { method: 'dialog' },
      h('h2', { id: 'save-title' }, kind === 'apply' ? t('applyTitle', { n }) : t('saveTitle', { n })),
      h(
        'p',
        {},
        kind === 'apply'
          ? t('applyDetail', { author: authorName ?? '', n, file: tokenFile })
          : t('saveDetail', { file: tokenFile, n })
      ),
      h(
        'ul',
        { class: 'dialog-changes' },
        changes.map((change) => h('li', {}, changeLabelElement(t, change), changeValuesElement(change, false)))
      ),
      status !== 'stale' &&
        h(
          'p',
          { class: 'dialog-meta' },
          summaryParts.map((part) => (part.nowrap ? h('span', { class: 'nowrap' }, part.text) : part.text))
        ),
      status === 'conflict' &&
        h(
          'p',
          { class: 'dialog-error is-warn', role: 'alert' },
          icon('alert', 15),
          h('span', {}, t('saveConflict', { n: conflictVersion }))
        ),
      status === 'failed' &&
        h('p', { class: 'dialog-error', role: 'alert' }, icon('alert', 15), h('span', {}, t('saveFailed'))),
      status === 'stale' &&
        h(
          'p',
          { class: 'dialog-error is-warn', role: 'alert' },
          icon('alert', 15),
          h(
            'span',
            {},
            t('applyStale', {
              names: (staleNames.length > 0
                ? staleNames
                : changes.map((c) => formatChangeName(t, c.name, c.theme))
              ).join(', '),
              author: (authorName ?? '').split(' ')[0] || (authorName ?? ''),
            })
          )
        ),
      h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', class: 'button', onclick: () => close() }, t('cancel')),
        confirmButton
      )
    )

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (status === 'saving') return
      if (status === 'conflict') {
        void (async () => {
          await options.onRebase?.(conflictVersion)
          close()
          toast(t('rebasedToast', { n: conflictVersion }))
        })()
        return
      }
      if (status === 'stale') {
        close()
        options.onEditInTokens?.()
        return
      }
      void (async () => {
        status = 'saving'
        render()
        const result = await options.onConfirm()
        if (result.outcome === 'done') {
          close()
          toast(t('savedToast', { n: result.savedVersion }))
          return
        }
        if (result.outcome === 'conflict') {
          conflictVersion = result.currentVersion
          status = 'conflict'
        } else if (result.outcome === 'stale') {
          staleNames = result.staleNames ?? []
          status = 'stale'
        } else {
          status = 'failed'
        }
        render()
      })()
    })

    const fresh = h(
      'dialog',
      {
        class: 'name-dialog save-dialog',
        'aria-labelledby': 'save-title',
        'aria-busy': String(status === 'saving'),
      },
      form
    )
    fresh.addEventListener('cancel', (event) => {
      event.preventDefault()
      if (status !== 'saving') close()
    })
    dialogEl?.remove()
    dialogEl = fresh
    document.body.append(fresh)
    fresh.showModal()
    ;(status === 'saving' ? fresh : confirmButton).focus()
  }

  render()
  return { close }
}
