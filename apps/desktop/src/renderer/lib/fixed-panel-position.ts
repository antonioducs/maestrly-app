import type { CSSProperties } from 'react'

/** Edges of a rectangle in viewport coordinates. */
export interface ViewportBox {
  left: number
  top: number
  right: number
  bottom: number
}

export interface FixedPanelPlacement {
  style: CSSProperties
  opensUp: boolean
}

/**
 * Rectangle that `position: fixed` offsets of a descendant of `host` are measured from. It is the viewport unless
 * an ancestor creates a containing block for fixed elements — a centered dialog's translate does, as do filters,
 * containment and others. A throwaway probe lets the browser answer instead of guessing which properties apply.
 */
export function fixedContainingBlock(host: Element): ViewportBox {
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none'
  host.appendChild(probe)
  try {
    const { left, top, right, bottom } = probe.getBoundingClientRect()
    return { left, top, right, bottom }
  } finally {
    probe.remove()
  }
}

/**
 * Place a floating panel next to `anchor`: below it, or above when the viewport lacks room below. Placement is
 * decided in viewport coordinates and then expressed relative to `container`, the panel's fixed containing block.
 */
export function placeFixedPanel(input: {
  anchor: ViewportBox
  viewport: { width: number; height: number }
  container: ViewportBox
  width: number
  estimatedHeight: number
  align?: 'start' | 'end'
  gap?: number
  margin?: number
}): FixedPanelPlacement {
  const { anchor, viewport, container, width, estimatedHeight } = input
  const gap = input.gap ?? 4
  const margin = input.margin ?? 8
  const opensUp = anchor.bottom + estimatedHeight > viewport.height && anchor.top > estimatedHeight
  const preferred = input.align === 'end' ? anchor.right - width : anchor.left
  const left = Math.max(margin, Math.min(preferred, viewport.width - width - margin))
  return {
    opensUp,
    style: {
      position: 'fixed',
      left: left - container.left,
      width,
      ...(opensUp
        ? { top: undefined, bottom: container.bottom - (anchor.top - gap) }
        : { top: anchor.bottom + gap - container.top, bottom: undefined }),
    },
  }
}

/** Measure `anchor` and the containing block of `host` (the element that will contain the panel) and place it. */
export function fixedPanelPlacement(
  host: Element,
  options: { anchor?: Element; width: number; estimatedHeight: number; align?: 'start' | 'end' }
): FixedPanelPlacement {
  const { left, top, right, bottom } = (options.anchor ?? host).getBoundingClientRect()
  return placeFixedPanel({
    anchor: { left, top, right, bottom },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    container: fixedContainingBlock(host),
    width: options.width,
    estimatedHeight: options.estimatedHeight,
    align: options.align,
  })
}
