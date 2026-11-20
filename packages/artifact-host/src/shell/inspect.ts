// Inspect mode UI: hover/selection/match boxes above the stage frame, stage hint, and the Inspect side panel.
import type { SelectionRect } from './contract.js'
import {
  clampInspectTag,
  formatElementLabel,
  formatInspectStyles,
  formatUsageSummary,
  tokenKey,
  viewportKindOf,
} from './design-ui-model.js'
import {
  classifyTokenValue,
  type DesignController,
  type DesignScreen,
  type DesignSnapshot,
  type InspectHover,
  type ScreenUsage,
} from './design-ui-stub.js'
import { copyText, h, toast } from './dom.js'
import type { Translate } from './i18n.js'
import { icon } from './icons.js'
import { displayTokenValue, swatchElement } from './suggestion-ui.js'

export interface InspectViewOptions {
  t: Translate
  controller: DesignController
  stage: HTMLElement
  overlay: HTMLElement
  float: HTMLElement
  side: HTMLElement
  /** Called when the user clicks a token in Inspect to jump to that row in Tokens. */
  onOpenToken(name: string): void
  /** Optional screen to return to via the "Back to {screen}" chip after jumping to a main component. */
  getBackScreen?: () => DesignScreen | null
  onBack?: () => void
  /** Optional click handler for ancestor breadcrumbs when core supports selecting by selector. */
  onSelectBreadcrumb?: (selector: string) => void
  /** Optional click handler for usage rows when core supports highlighting matches on a screen. */
  onShowUses?: (component: string, screenId: string) => void
}

export interface InspectView {
  render(snapshot: DesignSnapshot, matchRects?: readonly SelectionRect[]): void
  renderOverlay(snapshot: DesignSnapshot, matchRects?: readonly SelectionRect[]): void
  renderFloat(snapshot: DesignSnapshot): void
  destroy(): void
}

function section(title: string | null, count: number | undefined, ...children: Parameters<typeof h>[2][]): HTMLElement {
  return h(
    'section',
    { class: 'side-section' },
    title &&
      h(
        'h3',
        { class: 'side-heading' },
        title,
        count !== undefined && h('span', { class: 'tab-count' }, String(count))
      ),
    ...children
  )
}

function currentScreenOf(snapshot: DesignSnapshot): DesignScreen | null {
  if (!snapshot.design || !snapshot.stagePath) return null
  return snapshot.design.screens.find((screen) => screen.path === snapshot.stagePath) ?? null
}

export function createInspectView(options: InspectViewOptions): InspectView {
  const { t, controller, stage, overlay, float, side } = options
  let activeUsageScreenId: string | null = null

  function copyable(value: string, withSwatch: boolean): HTMLElement {
    return h(
      'button',
      {
        type: 'button',
        class: 'value',
        title: t('inspectCopy', { value }),
        onclick: async () => {
          await copyText(value)
          toast(t('inspectCopied', { value }))
        },
      },
      withSwatch && swatchElement(value),
      h('span', { class: 'value-text' }, value)
    )
  }

  function renderOverlay(snapshot: DesignSnapshot, matchRects: readonly SelectionRect[] = []): void {
    for (const el of overlay.querySelectorAll('.inspect-box, .inspect-tag')) el.remove()
    if (snapshot.view !== 'page') return
    const bounds = { width: overlay.clientWidth, height: overlay.clientHeight }

    const drawBox = (at: SelectionRect, kind: string) => {
      const el = h('div', { class: `inspect-box ${kind}` })
      el.style.setProperty('--x', `${at.x}px`)
      el.style.setProperty('--y', `${at.y}px`)
      el.style.setProperty('--w', `${at.width}px`)
      el.style.setProperty('--h', `${at.height}px`)
      overlay.append(el)
    }

    const drawTag = (target: InspectHover, at: SelectionRect) => {
      const label = target.component ?? formatElementLabel(target)
      const el = h(
        'span',
        { class: `inspect-tag${target.component ? '' : ' is-element'}`, 'aria-hidden': 'true' },
        target.component && icon(target.main ? 'main' : 'component', 11),
        label,
        h('span', { class: 'inspect-tag-size' }, `${Math.round(at.width)} × ${Math.round(at.height)}`)
      )
      overlay.append(el)
      const pos = clampInspectTag(at, el.offsetWidth, bounds)
      el.style.setProperty('--x', `${pos.x}px`)
      el.style.setProperty('--y', `${pos.y}px`)
    }

    for (const at of matchRects) drawBox(at, 'is-match')
    const hovering = snapshot.inspecting && snapshot.hovered
    if (hovering) drawBox(hovering.rect, 'is-hover')
    const selectedRect = snapshot.inspected ? (snapshot.inspectedRect ?? snapshot.inspected.rect) : null
    if (snapshot.inspected && selectedRect) {
      drawBox(selectedRect, 'is-selected')
      drawTag(snapshot.inspected, selectedRect)
    }
    if (hovering) drawTag(hovering, hovering.rect)
  }

  function renderFloat(snapshot: DesignSnapshot): void {
    const isPage = snapshot.view === 'page'
    stage.classList.toggle('is-inspecting', isPage && snapshot.inspecting)
    for (const el of float.querySelectorAll('.inspect-hint, .page-chip')) el.remove()
    if (!isPage) return

    if (snapshot.inspecting && !snapshot.inspected) {
      float.append(
        h(
          'div',
          { class: 'hint inspect-hint', role: 'status' },
          h('span', {}, t('inspectHint')),
          h(
            'button',
            { type: 'button', class: 'hint-exit', onclick: () => controller.setInspecting(false) },
            t('commentHintExit'),
            h('kbd', {}, 'Esc')
          )
        )
      )
    }

    const back = options.getBackScreen?.() ?? null
    const panelOpen = Boolean(snapshot.inspected) && !snapshot.tokensOpen
    if (back && !panelOpen && options.onBack) {
      float.append(
        h(
          'button',
          { type: 'button', class: 'page-chip', onclick: () => options.onBack?.() },
          icon('left', 15),
          t('inspectBack', { screen: back.name })
        )
      )
    }
  }

  function buildUsageSection(snapshot: DesignSnapshot, componentName: string): HTMLElement | null {
    const design = snapshot.design
    if (!design || design.screens.length === 0) return null
    const countsByScreen = new Map<string, ScreenUsage>()
    for (const entry of snapshot.componentUsage(componentName)) countsByScreen.set(entry.screenId, entry)

    const rows = design.screens.map((screen) => {
      const measured = countsByScreen.get(screen.id)
      const frameState = snapshot.screensState.get(screen.id)
      if (measured) return { screen, status: 'done' as const, count: measured.count }
      if (frameState?.status === 'error') return { screen, status: 'failed' as const, count: 0 }
      if (frameState?.status === 'loading') return { screen, status: 'measuring' as const, count: 0 }
      return { screen, status: 'queued' as const, count: 0 }
    })

    const isPending = (status: string) => status === 'queued' || status === 'measuring'
    const done = rows.filter((row) => !isPending(row.status)).length
    const total = rows.reduce((sum, row) => sum + row.count, 0)
    const screensWith = rows.filter((row) => row.count > 0).length
    const summary = formatUsageSummary(t, total, screensWith, done, rows.length)

    return section(
      t('inspectUses'),
      undefined,
      h('p', { class: 'usage-total', role: 'status' }, summary),
      done < rows.length &&
        h(
          'div',
          {
            class: 'usage-meter',
            role: 'progressbar',
            'aria-label': t('inspectUses'),
            'aria-valuemin': '0',
            'aria-valuemax': String(rows.length),
            'aria-valuenow': String(done),
          },
          h('span', { style: `width:${(done / rows.length) * 100}%` })
        ),
      h(
        'ul',
        { class: 'usage' },
        rows.map((row) => {
          const viewport = viewportKindOf(row.screen.viewport)
          const statusEl =
            row.status === 'measuring'
              ? h(
                  'span',
                  { class: 'usage-state' },
                  h('span', { class: 'spinner', 'aria-hidden': 'true' }),
                  t('inspectUsesMeasuring')
                )
              : row.status === 'queued'
                ? h('span', { class: 'usage-state is-queued' }, t('inspectUsesQueued'))
                : h(
                    'span',
                    { class: 'usage-count' },
                    row.status === 'failed' ? t('inspectUsesFailed') : String(row.count)
                  )
          const usable = row.status === 'done' && row.count > 0
          return h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                class: `usage-row${row.status === 'done' && row.count === 0 ? ' is-zero' : ''}${row.status === 'failed' ? ' is-failed' : ''}${isPending(row.status) ? ' is-measuring' : ''}`,
                'aria-current': activeUsageScreenId === row.screen.id ? 'true' : undefined,
                disabled: !usable,
                title: usable ? t('inspectUsesShow', { n: row.count, screen: row.screen.name }) : undefined,
                onclick: () => {
                  activeUsageScreenId = row.screen.id
                  if (options.onShowUses) options.onShowUses(componentName, row.screen.id)
                  else void controller.openScreen(row.screen.id)
                },
              },
              icon(viewport, 14),
              h('span', { class: 'usage-name' }, row.screen.name),
              statusEl
            )
          )
        })
      )
    )
  }

  function renderPanel(snapshot: DesignSnapshot): void {
    const target = snapshot.inspected
    if (!target || snapshot.tokensOpen) {
      if (side.classList.contains('inspect-panel')) {
        side.hidden = true
        side.className = 'side'
        side.replaceChildren()
      }
      return
    }

    const design = snapshot.design
    const kind = target.component ? (target.main ? 'main' : 'component') : 'element'
    const screen = currentScreenOf(snapshot)
    const name = target.component ?? formatElementLabel(target)
    const sub =
      kind === 'main'
        ? t('inspectMain', { file: design?.componentsPath ?? 'components.html' })
        : kind === 'component'
          ? screen
            ? t('inspectInstance', { screen: screen.name })
            : t('inspectInstancePage')
          : t('inspectElement')

    const head = h(
      'header',
      { class: 'side-head' },
      h('span', { class: `side-mark${kind === 'element' ? ' is-element' : ''}` }, icon(kind, 16)),
      h('div', { class: 'side-title' }, h('h2', { title: name }, name), h('p', { class: 'side-sub' }, sub)),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button',
          'aria-label': t('inspectClose'),
          title: t('inspectClose'),
          onclick: () => controller.clearSelection(),
        },
        icon('close', 15)
      )
    )

    const body = h('div', { class: 'side-body' })
    const back = options.getBackScreen?.() ?? null
    if (back && options.onBack) {
      body.append(
        h(
          'button',
          { type: 'button', class: 'link side-back', onclick: () => options.onBack?.() },
          icon('left', 14),
          t('inspectBack', { screen: back.name })
        )
      )
    }

    if (!design) {
      body.append(section(null, undefined, h('p', { class: 'side-note' }, t('inspectNoContract'))))
    }

    if (kind === 'component' && target.component) {
      const hasComponents = Boolean(design?.componentsPath)
      const componentName = target.component
      body.append(
        section(
          null,
          undefined,
          h(
            'button',
            {
              type: 'button',
              class: 'button go-main',
              disabled: !hasComponents,
              title: hasComponents ? undefined : t('inspectNoComponents'),
              onclick: async () => {
                const found = await controller.openMainComponent(componentName)
                if (!found && design?.componentsPath) {
                  toast(t('inspectMainMissing', { name: componentName, file: design.componentsPath }))
                }
              },
            },
            icon('main', 15),
            t('inspectGoMain'),
            icon('arrow', 14)
          )
        )
      )
    }

    if (kind === 'main' && target.component) {
      const usage = buildUsageSection(snapshot, target.component)
      if (usage) body.append(usage)
    }

    if (target.component) {
      const propEntries = Object.entries(target.props)
      body.append(
        section(
          t('inspectProps'),
          undefined,
          propEntries.length > 0
            ? h(
                'dl',
                { class: 'props' },
                propEntries.map(([key, value]) =>
                  h('div', { class: 'prop' }, h('dt', {}, key), h('dd', {}, h('span', { class: 'prop-chip' }, value)))
                )
              )
            : h('p', { class: 'side-note' }, t('inspectNoProps'))
        )
      )
    }

    if (design) {
      const changedKeys = new Set(snapshot.draftChanges.map((change) => tokenKey(change.name, change.theme)))
      const isChanged = (tokenName: string) =>
        (snapshot.activeTheme !== null && changedKeys.has(tokenKey(tokenName, snapshot.activeTheme))) ||
        changedKeys.has(tokenKey(tokenName, null))

      body.append(
        section(
          t('inspectTokens'),
          target.tokens.length || undefined,
          target.tokens.length > 0
            ? h(
                'ul',
                { class: 'token-uses' },
                target.tokens.map((used) => {
                  const tokenKind = classifyTokenValue(used.name, used.value)
                  return h(
                    'li',
                    {},
                    h(
                      'button',
                      {
                        type: 'button',
                        class: `token-use${isChanged(used.name) ? ' is-changed' : ''}`,
                        title: t('inspectEditToken', { name: used.name }),
                        onclick: () => options.onOpenToken(used.name),
                      },
                      h('span', { class: 'token-use-name' }, used.name),
                      h(
                        'span',
                        { class: 'token-use-value' },
                        tokenKind === 'color' && swatchElement(used.value),
                        h('span', { class: 'value-text' }, displayTokenValue(used.value, tokenKind))
                      )
                    )
                  )
                })
              )
            : h('p', { class: 'side-note' }, t('inspectTokensNone'))
        )
      )
    }

    const styleRows = formatInspectStyles(target, t)
    body.append(
      section(
        t('inspectStyles'),
        undefined,
        h(
          'dl',
          { class: 'props' },
          styleRows.map((row) =>
            h('div', { class: 'prop' }, h('dt', {}, row.label), h('dd', {}, copyable(row.value, row.swatch)))
          )
        )
      )
    )

    side.hidden = false
    side.className = 'side inspect-panel'
    side.setAttribute('aria-label', t('inspectPanel'))
    side.replaceChildren(head, body)
  }

  return {
    render(snapshot, matchRects = []) {
      renderOverlay(snapshot, matchRects)
      renderFloat(snapshot)
      renderPanel(snapshot)
    },
    renderOverlay,
    renderFloat,
    destroy() {
      stage.classList.remove('is-inspecting')
      for (const el of overlay.querySelectorAll('.inspect-box, .inspect-tag')) el.remove()
      for (const el of float.querySelectorAll('.inspect-hint, .page-chip')) el.remove()
      if (side.classList.contains('inspect-panel')) {
        side.hidden = true
        side.className = 'side'
        side.replaceChildren()
      }
    },
  }
}
