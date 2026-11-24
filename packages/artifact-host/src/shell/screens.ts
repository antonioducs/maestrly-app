// Screens canvas view: pannable/zoomable layout of every screen in `maestrly-design.json`, hosting the live iframes
// the `DesignController` creates in each card and showing zoom + focus controls in the stage's floating layer.
import {
  arrangeScreens,
  fitAllCamera,
  fitScreenCamera,
  type PlacedScreen,
  rankVisibleScreens,
  type ScreenCamera,
  type ScreensLayout,
  shouldHideScreenSize,
  viewportKindOf,
  zoomAtCamera,
} from './design-ui-model.js'
import type { DesignScreen } from './contract.js'
import type { DesignController, DesignSnapshot } from './design.js'
import { thumbnailSize } from './design-model.js'
import { h } from './dom.js'
import type { Translate } from './i18n.js'
import { icon } from './icons.js'

const LIVE_DEBOUNCE_MS = 120

export interface ScreensSurfaceOptions {
  t: Translate
  controller: DesignController
  stage: HTMLElement
  float: HTMLElement
  /** Called when a screen is opened into Page view so the stage adjusts its viewport preset. */
  onScreenOpened?: (screen: DesignScreen) => void
}

export interface ScreensSurface {
  readonly surface: HTMLElement
  sync(snapshot: DesignSnapshot): void
  renderControls(snapshot: DesignSnapshot): void
  resize(): void
  focus(screenId: string | null, animate?: boolean): void
  destroy(): void
}

interface ScreenEntry extends PlacedScreen {
  el: HTMLElement
  labelEl: HTMLElement
  nameEl: HTMLElement
  sizeEl: HTMLElement
  frameBox: HTMLElement
  placeholder: HTMLElement
  /** The screen's picture, shown whenever its live frame is not ready. */
  thumb: HTMLImageElement | null
  /** Width in CSS pixels of the screen's picture: above it on screen (times the pixel ratio), the frame stays live. */
  thumbWidth: number
  lastStatus: string
  /** Natural (untruncated) CSS pixel widths of the label text, measured once so `.is-compact` never flickers. */
  nameWidth: number
  sizeWidth: number
}

type FrameStatus = 'idle' | 'loading' | 'ready' | 'error'

/** What the camera keeps framed when the stage resizes: every screen, the selected one, or wherever the person left it. */
type Framing = 'all' | 'screen' | 'free'

export function createScreensSurface(options: ScreensSurfaceOptions): ScreensSurface {
  const { t, controller, stage, float } = options
  const initial = controller.snapshot()
  const screens = initial.design?.screens ?? []

  const world = h('div', { class: 'screens-world' })
  const surface = h('div', { class: 'screens', role: 'region', 'aria-label': t('screensLabel'), tabindex: '0' }, world)
  stage.append(surface)

  let layout: ScreensLayout = arrangeScreens(screens, surface.getBoundingClientRect())
  let cam: ScreenCamera = { x: 0, y: 0, z: 0.2 }
  let framing: Framing = 'all'
  let currentFocus: string | null = initial.focusedScreenId
  let zoomLabel: HTMLButtonElement | null = null
  const items = new Map<string, ScreenEntry>()

  for (const item of layout.placed) {
    const { screen, width, height } = item
    const fullLabel = t('screenLabel', { name: screen.name, width, height })
    const placeholder = h('div', { class: 'screen-placeholder' })
    const frameBox = h('div', { class: 'screen-frame' }, placeholder)
    const nameEl = h('b', {}, screen.name)
    const sizeEl = h('span', { class: 'screen-size' }, t('screenSize', { width, height }))
    const labelEl = h('div', { class: 'screen-label', title: fullLabel }, nameEl, sizeEl)
    const el = h(
      'div',
      {
        class: 'screen',
        role: 'button',
        tabindex: '-1',
        'data-screen': screen.id,
        'aria-label': fullLabel,
        'aria-pressed': 'false',
        title: fullLabel,
      },
      labelEl,
      frameBox
    )
    el.style.left = `${item.x}px`
    el.style.top = `${item.y}px`
    el.style.width = `${width}px`
    el.style.height = `${height}px`
    el.style.setProperty('--w', `${width}px`)
    world.append(el)
    items.set(screen.id, {
      ...item,
      el,
      labelEl,
      nameEl,
      sizeEl,
      frameBox,
      placeholder,
      thumb: null,
      thumbWidth: thumbnailSize(width, height).width,
      lastStatus: '',
      nameWidth: 0,
      sizeWidth: 0,
    })
  }

  function measureLabelWidths(): void {
    for (const entry of items.values()) {
      if (entry.nameWidth > 0 && entry.sizeWidth > 0) continue
      const wasCompact = entry.labelEl.classList.contains('is-compact')
      if (wasCompact) entry.labelEl.classList.remove('is-compact')
      entry.nameWidth = entry.nameEl.scrollWidth
      entry.sizeWidth = entry.sizeEl.scrollWidth
      if (wasCompact) entry.labelEl.classList.add('is-compact')
    }
  }

  function updateLabelCompactness(): void {
    measureLabelWidths()
    for (const entry of items.values()) {
      const compact = entry.nameWidth > 0 && shouldHideScreenSize(entry.width * cam.z, entry.nameWidth, entry.sizeWidth)
      entry.labelEl.classList.toggle('is-compact', compact)
    }
  }

  function renderThumb(entry: ScreenEntry, image: string | null | undefined, status: FrameStatus): boolean {
    const shown = Boolean(image) && status !== 'ready'
    if (image && !entry.thumb) {
      entry.thumb = h('img', { class: 'screen-thumb', alt: '', draggable: 'false', decoding: 'async' })
      entry.frameBox.insertBefore(entry.thumb, entry.placeholder)
    }
    if (entry.thumb) {
      if (image && entry.thumb.getAttribute('src') !== image) entry.thumb.src = image
      entry.thumb.hidden = !shown
    }
    return shown
  }

  /**
   * What a screen shows without a ready frame: its picture when there is one; otherwise a calm card while it waits for
   * its turn, a spinner while it loads, or why it failed. A screen that cannot be drawn loads when it is selected.
   */
  function renderPlaceholder(entry: ScreenEntry, status: FrameStatus, image: string | null | undefined): void {
    const pictured = renderThumb(entry, image, status)
    const state = pictured ? 'pictured' : status === 'idle' && image === null ? 'undrawable' : status
    if (entry.lastStatus === state) return
    entry.lastStatus = state
    entry.placeholder.hidden = state === 'ready' || state === 'pictured'
    entry.placeholder.classList.toggle('is-failed', state === 'error')
    entry.placeholder.classList.toggle('is-idle', state === 'idle' || state === 'undrawable')
    if (entry.placeholder.hidden) return
    entry.placeholder.replaceChildren(
      h(
        'div',
        { class: 'screen-placeholder-body' },
        status === 'error'
          ? [
              h('p', {}, t('screenFailed')),
              h(
                'button',
                {
                  type: 'button',
                  class: 'button',
                  onclick: (event: Event) => {
                    event.stopPropagation()
                    controller.retryScreen(entry.screen.id)
                  },
                },
                t('retry')
              ),
            ]
          : state === 'idle' || state === 'undrawable'
            ? [
                icon(viewportKindOf(entry.screen.viewport), 28),
                h('p', {}, t(state === 'idle' ? 'screenQueued' : 'screenIdle')),
              ]
            : [h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', {}, t('loading'))]
      )
    )
  }

  let visibleTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleVisibleSync(immediate = false): void {
    if (visibleTimer !== null) clearTimeout(visibleTimer)
    const run = () => {
      visibleTimer = null
      const box = surface.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return
      const visibleIds = rankVisibleScreens(layout.placed, cam, box)
      const ratio = window.devicePixelRatio || 1
      // A picture holds up to a little past its own size; shown any larger, the screen needs its live frame.
      const detailIds = visibleIds.filter((id) => {
        const entry = items.get(id)
        return entry !== undefined && entry.width * cam.z * ratio > entry.thumbWidth * 1.15
      })
      controller.setVisibleScreens(visibleIds, currentFocus, detailIds)
    }
    if (immediate) run()
    else visibleTimer = setTimeout(run, LIVE_DEBOUNCE_MS)
  }

  function applyCamera(animate: boolean): void {
    world.classList.toggle('is-moving', animate)
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`
    world.style.setProperty('--zoom', String(cam.z))
    if (zoomLabel) zoomLabel.textContent = `${Math.round(cam.z * 100)}%`
    updateLabelCompactness()
    scheduleVisibleSync()
  }

  function relayout(): void {
    const next = arrangeScreens(screens, surface.getBoundingClientRect())
    if (next.width === layout.width && next.height === layout.height && next.rowMax === layout.rowMax) return
    layout = next
    for (const item of next.placed) {
      const entry = items.get(item.screen.id)
      if (!entry) continue
      entry.x = item.x
      entry.y = item.y
      entry.row = item.row
      entry.el.style.left = `${item.x}px`
      entry.el.style.top = `${item.y}px`
    }
  }

  function fitAll(animate = false): void {
    cam = fitAllCamera({ width: layout.width, height: layout.height }, surface.getBoundingClientRect())
    framing = 'all'
    applyCamera(animate)
  }

  function fitScreen(id: string, animate = true): void {
    const entry = items.get(id)
    if (!entry) return
    cam = fitScreenCamera(entry, surface.getBoundingClientRect())
    framing = 'screen'
    applyCamera(animate)
  }

  function zoomAt(px: number, py: number, factor: number): void {
    cam = zoomAtCamera(cam, px, py, factor)
    framing = 'free'
    applyCamera(false)
  }

  function zoomCenter(factor: number): void {
    const box = surface.getBoundingClientRect()
    zoomAt(box.width / 2, box.height / 2, factor)
  }

  function applyFocusStyles(id: string | null): void {
    const firstId = layout.placed[0]?.screen.id ?? null
    for (const [key, entry] of items) {
      entry.el.classList.toggle('is-focused', key === id)
      entry.el.setAttribute('aria-pressed', String(key === id))
      entry.el.tabIndex = key === (id ?? firstId) ? 0 : -1
    }
  }

  /** Selects a screen without moving the camera, so a click never feels like it went somewhere else. */
  function select(id: string | null, notifyController = true): void {
    currentFocus = id
    applyFocusStyles(id)
    if (notifyController) controller.focusScreen(id)
  }

  /** Selects a screen and frames it, or frames every screen when `id` is null. */
  function setFocus(id: string | null, animate = true, notifyController = true): void {
    select(id, notifyController)
    if (id) fitScreen(id, animate)
    else fitAll(animate)
  }

  /** Clears the selection, returning to every screen only when the camera was framing the selected one. */
  function clearFocus(animate = true, notifyController = true): void {
    if (framing === 'screen') setFocus(null, animate, notifyController)
    else select(null, notifyController)
  }

  function reframe(): void {
    relayout()
    if (framing === 'screen' && currentFocus) fitScreen(currentFocus, false)
    else if (framing === 'all' || framing === 'screen') fitAll(false)
    else updateLabelCompactness()
  }

  function step(delta: number): void {
    if (!layout.placed.length) return
    const order = layout.placed.map((item) => item.screen.id)
    const at = currentFocus ? order.indexOf(currentFocus) : -1
    const id = at < 0 ? order[0] : order[(at + delta + order.length) % order.length]
    setFocus(id)
    items.get(id)?.el.focus({ preventScroll: true })
  }

  function stepRow(delta: number): void {
    if (!layout.placed.length) return
    const from = (currentFocus ? items.get(currentFocus) : null) ?? items.get(layout.placed[0].screen.id)
    if (!from) return
    const candidates = layout.placed.filter((item) => item.row === from.row + delta)
    if (!candidates.length) return
    const middle = from.x + from.width / 2
    const nearest = candidates.reduce((best, item) =>
      Math.abs(item.x + item.width / 2 - middle) < Math.abs(best.x + best.width / 2 - middle) ? item : best
    )
    setFocus(nearest.screen.id)
    items.get(nearest.screen.id)?.el.focus({ preventScroll: true })
  }

  // Pointer panning, clicking to select, double-clicking to open, and wheel pan/zoom.
  let drag: { x: number; y: number; cx: number; cy: number; moved: boolean; id: string | null } | null = null
  // Pointer capture retargets clicks to the surface, so the double-click opens the screen the last press landed on.
  let pressed: { id: string | null; moved: boolean } | null = null
  surface.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (event.button !== 0 || target?.closest('button')) return
    drag = {
      x: event.clientX,
      y: event.clientY,
      cx: cam.x,
      cy: cam.y,
      moved: false,
      id: target?.closest<HTMLElement>('.screen')?.dataset.screen ?? null,
    }
    surface.setPointerCapture(event.pointerId)
  })
  surface.addEventListener('pointermove', (event) => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) < 4) return
    drag.moved = true
    surface.classList.add('is-panning')
    cam = { ...cam, x: drag.cx + dx, y: drag.cy + dy }
    framing = 'free'
    applyCamera(false)
  })
  surface.addEventListener('pointerup', () => {
    if (!drag) return
    const { moved, id } = drag
    drag = null
    pressed = { id, moved }
    surface.classList.remove('is-panning')
    if (moved || id === currentFocus) return
    if (id) select(id)
    else clearFocus()
  })
  surface.addEventListener('pointercancel', () => {
    drag = null
    pressed = null
    surface.classList.remove('is-panning')
  })
  function openScreen(id: string): void {
    const entry = items.get(id)
    if (entry) options.onScreenOpened?.(entry.screen)
    void controller.openScreen(id)
  }

  surface.addEventListener('dblclick', (event) => {
    const id = pressed
      ? !pressed.moved && pressed.id
      : event.target instanceof Element && event.target.closest<HTMLElement>('.screen')?.dataset.screen
    if (id) openScreen(id)
  })
  surface.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const box = surface.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) {
        zoomAt(event.clientX - box.left, event.clientY - box.top, Math.exp(-event.deltaY * 0.01))
      } else {
        cam = { ...cam, x: cam.x - event.deltaX, y: cam.y - event.deltaY }
        framing = 'free'
        applyCamera(false)
      }
    },
    { passive: false }
  )
  surface.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'ArrowRight') step(1)
    else if (event.key === 'ArrowLeft') step(-1)
    else if (event.key === 'ArrowDown') stepRow(1)
    else if (event.key === 'ArrowUp') stepRow(-1)
    else if (event.key === 'Enter' && currentFocus) openScreen(currentFocus)
    else if (event.key === '+' || event.key === '=') zoomCenter(1.25)
    else if (event.key === '-' || event.key === '_') zoomCenter(0.8)
    else if (event.key === '0') setFocus(null)
    else return
    event.preventDefault()
  })

  const observer = new ResizeObserver(reframe)
  observer.observe(surface)

  function renderControls(snapshot: DesignSnapshot): void {
    for (const el of float.querySelectorAll('.zoom, .screen-focus')) el.remove()
    if (snapshot.view !== 'screens') return
    zoomLabel = h(
      'button',
      { type: 'button', class: 'zoom-level', title: t('zoomFitTitle'), onclick: () => setFocus(null) },
      `${Math.round(cam.z * 100)}%`
    )
    float.append(
      h(
        'div',
        { class: 'zoom', role: 'group', 'aria-label': t('zoomGroup') },
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('zoomOut'),
            title: t('zoomOut'),
            onclick: () => zoomCenter(0.8),
          },
          icon('minus', 15)
        ),
        zoomLabel,
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('zoomIn'),
            title: t('zoomIn'),
            onclick: () => zoomCenter(1.25),
          },
          icon('plus', 15)
        ),
        h('span', { class: 'zoom-divider', 'aria-hidden': 'true' }),
        h(
          'button',
          { type: 'button', class: 'zoom-fit', title: t('zoomFitTitle'), onclick: () => setFocus(null) },
          t('zoomFit')
        )
      )
    )

    const focused = snapshot.focusedScreenId ? items.get(snapshot.focusedScreenId) : null
    if (!focused) return
    const at = layout.placed.findIndex((item) => item.screen.id === focused.screen.id)
    float.append(
      h(
        'div',
        { class: 'screen-focus', role: 'group', 'aria-label': focused.screen.name },
        h(
          'span',
          { class: 'stepper' },
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button',
              'aria-label': t('screenPrevious'),
              title: t('screenPrevious'),
              onclick: () => step(-1),
            },
            icon('left', 15)
          ),
          h('span', { class: 'stepper-at' }, t('threadAt', { n: at + 1, total: layout.placed.length })),
          h(
            'button',
            {
              type: 'button',
              class: 'icon-button',
              'aria-label': t('screenNext'),
              title: t('screenNext'),
              onclick: () => step(1),
            },
            icon('right', 15)
          )
        ),
        h(
          'span',
          { class: 'screen-focus-name' },
          h('b', {}, focused.screen.name),
          h('span', { class: 'screen-size' }, t('screenSize', { width: focused.width, height: focused.height }))
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'button small primary',
            title: t('screenOpenTitle', { name: focused.screen.name }),
            onclick: () => openScreen(focused.screen.id),
          },
          t('screenOpen'),
          h('kbd', {}, '↵')
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-button',
            'aria-label': t('screenUnfocus'),
            title: t('screenUnfocus'),
            onclick: () => setFocus(null),
          },
          icon('close', 15)
        )
      )
    )
  }

  function sync(snapshot: DesignSnapshot): void {
    if (snapshot.focusedScreenId !== currentFocus) {
      if (snapshot.focusedScreenId) setFocus(snapshot.focusedScreenId, true, false)
      else clearFocus(true, false)
    }
    for (const [id, entry] of items) {
      const status = snapshot.screensState.get(id)?.status ?? 'idle'
      renderPlaceholder(entry, status, snapshot.screenThumbnails.get(id))
    }
    renderControls(snapshot)
  }

  for (const [id, entry] of items) renderPlaceholder(entry, 'idle', initial.screenThumbnails.get(id))
  // The controller creates each live frame inside its card: moving a loaded iframe would reload it.
  controller.setScreenHost((id) => items.get(id)?.frameBox ?? null)
  // The canvas opens on every screen; the screen last opened stays selected without the camera jumping to it.
  applyFocusStyles(currentFocus)
  requestAnimationFrame(() => fitAll(false))

  return {
    surface,
    sync,
    renderControls,
    resize: reframe,
    focus(id, animate = true) {
      if (id) setFocus(id, animate)
      else clearFocus(animate)
    },
    destroy() {
      if (visibleTimer !== null) clearTimeout(visibleTimer)
      observer.disconnect()
      // Frames the controller keeps (to measure components) go back to its hidden host instead of being dropped.
      controller.setScreenHost(null)
      for (const el of float.querySelectorAll('.zoom, .screen-focus')) el.remove()
      surface.remove()
    },
  }
}
