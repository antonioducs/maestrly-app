import { describe, expect, it } from 'vitest'
import { DRAWER_EDGE, shouldDragDrawer } from '../src/ui/drawer/drawer-gesture'

describe('drawer gesture', () => {
  it('opens only from a rightward drag that starts at the left edge', () => {
    expect(shouldDragDrawer(false, { moveX: 40, dx: 30, dy: 2 })).toBe(true)
    expect(shouldDragDrawer(false, { moveX: DRAWER_EDGE + 20, dx: 20, dy: 0 })).toBe(true)
  })

  it('leaves a rightward drag in the middle of the screen to the content under it', () => {
    // A table or code block scrolled back to its start: before the grant, PanResponder reports x0 as 0.
    expect(shouldDragDrawer(false, { moveX: 230, dx: 30, dy: 2 })).toBe(false)
  })

  it('never opens from a leftward or mostly vertical drag', () => {
    expect(shouldDragDrawer(false, { moveX: 0, dx: -20, dy: 0 })).toBe(false)
    expect(shouldDragDrawer(false, { moveX: 30, dx: 20, dy: 20 })).toBe(false)
    expect(shouldDragDrawer(false, { moveX: 10, dx: 5, dy: 0 })).toBe(false)
  })

  it('closes from a leftward drag anywhere', () => {
    expect(shouldDragDrawer(true, { moveX: 200, dx: -30, dy: 3 })).toBe(true)
    expect(shouldDragDrawer(true, { moveX: 260, dx: 30, dy: 0 })).toBe(false)
  })
})
