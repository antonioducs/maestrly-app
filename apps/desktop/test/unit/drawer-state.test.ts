import { beforeEach, describe, expect, it } from 'vitest'
import {
  drawers,
  getDrawer,
  isTabVisibleInSlot,
  placementByConv,
  setActiveConvId,
  setSlot,
  setSuppressed,
  setVisibleKind,
} from '../../src/main/drawer/state'

describe('drawer visibility state', () => {
  beforeEach(() => {
    drawers.clear()
    placementByConv.clear()
    setActiveConvId(null)
    setVisibleKind(null)
    setSlot(null)
    setSuppressed(false)
  })

  it('considers the editor outside the slot when another tool has a popup', () => {
    const drawer = getDrawer('c1')
    drawer.vscodeView = {} as never
    setActiveConvId('c1')
    setVisibleKind('vscode')
    setSlot({ x: 0, y: 0, width: 100, height: 100 })

    expect(isTabVisibleInSlot('c1', 'vscode')).toBe(true)

    placementByConv.set('c1', new Map([['notes', 'popup']]))

    expect(isTabVisibleInSlot('c1', 'vscode')).toBe(false)
  })

  it('considers the editor outside the slot while a modal suppresses native views', () => {
    const drawer = getDrawer('c1')
    drawer.vscodeView = {} as never
    setActiveConvId('c1')
    setVisibleKind('vscode')
    setSlot({ x: 0, y: 0, width: 100, height: 100 })
    setSuppressed(true)

    expect(isTabVisibleInSlot('c1', 'vscode')).toBe(false)
  })
})
