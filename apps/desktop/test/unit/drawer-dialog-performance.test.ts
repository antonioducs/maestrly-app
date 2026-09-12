import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  setResourcePlacementActive: vi.fn(),
  setResourceVisible: vi.fn(),
}))

vi.mock('../../src/main/performance/resource-governor', () => h)
vi.mock('../../src/main/chat/chatgpt-web/companion-window', () => ({ noteChatGptSurfaceVisibility: vi.fn() }))

import {
  drawers,
  getDrawer,
  initDrawer,
  placementByConv,
  setActiveConvId,
  setDialogSuppressionOwnerIds,
  setSlot,
  setVisibleKind,
} from '../../src/main/drawer/state'
import { syncDrawerResourcePerformance } from '../../src/main/drawer/performance'

describe('drawer Dialog suppression performance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drawers.clear()
    placementByConv.clear()
    setActiveConvId(null)
    setVisibleKind(null)
    setSlot(null)
    setDialogSuppressionOwnerIds([])
    initDrawer({ webContents: { getZoomFactor: () => 1 } } as never)
  })

  it('keeps the owning panel at full speed while unrelated modal owners throttle it', () => {
    getDrawer('c1').panelViews.set('plan', { webContents: { id: 42 } } as never)
    setActiveConvId('c1')
    setVisibleKind('plan')
    setSlot({ x: 0, y: 0, width: 800, height: 600 })

    setDialogSuppressionOwnerIds([42])
    syncDrawerResourcePerformance()
    expect(h.setResourceVisible).toHaveBeenCalledWith('panel', 'c1', 'plan', true)

    h.setResourceVisible.mockClear()
    setDialogSuppressionOwnerIds([999])
    syncDrawerResourcePerformance()
    expect(h.setResourceVisible).toHaveBeenCalledWith('panel', 'c1', 'plan', false)
  })
})
