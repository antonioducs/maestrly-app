import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToasts, dismissToasts, getToasts, toast, Toaster } from '../../src/renderer/components/ui/toaster'

beforeEach(() => {
  vi.useFakeTimers()
  clearToasts()
})

afterEach(() => {
  clearToasts()
  vi.useRealTimers()
})

describe('Toaster', () => {
  it('keeps at most 3 toasts, auto-closes after 7s, and renders aria-live polite region', () => {
    for (let i = 1; i <= 5; i++) {
      toast({ tone: 'ok', title: `Toast ${i}`, description: `Sub ${i}` })
    }
    expect(getToasts().map((t) => t.title)).toEqual(['Toast 3', 'Toast 4', 'Toast 5'])

    const html = renderToStaticMarkup(createElement(Toaster))
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Toast 3')
    expect(html).toContain('Toast 5')
    expect(html).not.toContain('Toast 1')

    vi.advanceTimersByTime(7000)
    expect(getToasts()).toEqual([])
  })

  it('supports selective dismissal and action buttons', () => {
    toast({
      id: 'run-1',
      tone: 'notable',
      title: 'Price dropped',
      description: 'Now R$ 3.790',
      action: { label: 'Open run', onClick: vi.fn() },
    })
    toast({ id: 'other', tone: 'skip', title: 'Other' })

    const html = renderToStaticMarkup(createElement(Toaster))
    expect(html).toContain('Open run')
    dismissToasts((t) => t.id === 'run-1')
    expect(getToasts().map((t) => t.id)).toEqual(['other'])
  })

  it('layers toasts below modal dialog overlays so they do not cover dialog footers', () => {
    toast({ tone: 'ok', title: 'Routine running' })
    const html = renderToStaticMarkup(createElement(Toaster))
    const dialogSrc = readFileSync(
      new URL('../../src/renderer/components/ui/dialog.tsx', import.meta.url),
      'utf8'
    )
    expect(dialogSrc).toContain('z-50')
    expect(html).not.toContain('z-[70]')
    expect(html).toContain('z-[45]')
  })
})
