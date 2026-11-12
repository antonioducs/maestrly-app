import { describe, expect, it } from 'vitest'
import { emptyBoard, orderedElements } from '../src/board.js'
import { checkBoard } from '../src/check.js'
import { boxOf, contains } from '../src/geometry.js'
import { applyOps, type Op, opsSchema } from '../src/ops.js'
import { applied, build, expectConsistent, get, NOW, textOf } from './helpers.js'

const retro: Op[] = [
  { op: 'section', id: 'good', title: 'Went well' },
  { op: 'section', id: 'bad', title: 'To improve' },
  { op: 'card', id: 'ci', text: 'CI got faster after the cache change', in: 'good', color: 'green' },
  { op: 'card', id: 'pairing', text: 'Pairing on the release', in: 'good', color: 'green' },
  { op: 'card', id: 'flaky', text: 'Flaky E2E on Windows', in: 'good', color: 'green' },
  { op: 'card', id: 'docs', text: 'Docs lag behind features', in: 'bad', color: 'red' },
  { op: 'connect', from: 'flaky', to: 'docs', label: 'same root cause?' },
]

describe('applyOps', () => {
  it('builds sections, cards with their text and labelled links in one revision', () => {
    const result = applied(applyOps(emptyBoard(), { baseRevision: 0, ops: retro, now: NOW }))
    const board = result.board
    expect(board.revision).toBe(1)
    expect(result.created).toEqual(['good', 'bad', 'ci', 'pairing', 'flaky', 'docs', 'flaky-docs'])
    expect(result.applied).toEqual([0, 1, 2, 3, 4, 5, 6])
    expectConsistent(board)

    expect(get(board, 'ci').frameId).toBe('good')
    expect(textOf(board, 'ci')?.frameId).toBe('good')
    expect(textOf(board, 'ci')?.originalText).toBe('CI got faster after the cache change')
    expect(get(board, 'ci').backgroundColor).toBe('#b2f2bb')
    const arrow = get(board, 'flaky-docs')
    expect(arrow.startBinding?.elementId).toBe('flaky')
    expect(arrow.endBinding?.elementId).toBe('docs')
    expect(arrow.frameId).toBeNull()
    expect(textOf(board, 'flaky-docs')?.text).toBe('same root cause?')
    // Sections line up and grow around what they hold, and nothing is piled up.
    expect(get(board, 'bad').x).toBeGreaterThan(get(board, 'good').x + get(board, 'good').width)
    for (const id of ['ci', 'pairing', 'flaky'])
      expect(contains(boxOf(get(board, 'good')), boxOf(get(board, id)))).toBe(true)
    expect(checkBoard(board)).toEqual([])
  })

  it('places cards by the side of another one', () => {
    const board = build([
      { op: 'card', id: 'a', text: 'A', at: { x: 100, y: 100 } },
      { op: 'card', id: 'b', text: 'B', at: { near: 'a', side: 'below', gap: 50 } },
      { op: 'card', id: 'c', text: 'C', at: { near: 'a' } },
    ])
    const a = get(board, 'a')
    expect(get(board, 'b').y).toBe(a.y + a.height + 50)
    expect(get(board, 'c').x).toBe(a.x + a.width + 60)
    expect(get(board, 'c').y + get(board, 'c').height / 2).toBe(a.y + a.height / 2)
  })

  it('moves a card with its text and keeps its arrows attached', () => {
    const before = build(retro)
    const after = applied(
      applyOps(before, { baseRevision: 1, ops: [{ op: 'move', id: 'docs', to: { x: 2000, y: 900 } }], now: NOW })
    ).board
    expectConsistent(after)
    const card = get(after, 'docs')
    expect([card.x, card.y]).toEqual([2000, 900])
    const text = textOf(after, 'docs')!
    expect(text.x - card.x).toBeCloseTo(textOf(before, 'docs')!.x - get(before, 'docs').x)
    const arrow = get(after, 'flaky-docs')
    const end = arrow.points!.at(-1)!
    // The arrow ends next to the card's new place, a gap away from its edge.
    expect(arrow.x + end[0]).toBeGreaterThan(card.x - 20)
    expect(arrow.y + end[1]).toBeLessThan(card.y + card.height + 20)
    expect(arrow.version).toBe(get(before, 'flaky-docs').version + 1)
    expect(after.revision).toBe(2)
  })

  it('moves a section with everything in it', () => {
    const before = build(retro)
    const after = build([{ op: 'move', id: 'good', to: { x: -500, y: -500 } }], before)
    const dx = get(after, 'good').x - get(before, 'good').x
    expect(get(after, 'pairing').x - get(before, 'pairing').x).toBe(dx)
    expect(textOf(after, 'pairing')!.x - textOf(before, 'pairing')!.x).toBe(dx)
    expect(checkBoard(after)).toEqual([])
  })

  it('moves a card into another section, finding it a free place', () => {
    const before = build(retro)
    const after = build([{ op: 'move', id: 'pairing', in: 'bad' }], before)
    expect(get(after, 'pairing').frameId).toBe('bad')
    expect(textOf(after, 'pairing')!.frameId).toBe('bad')
    expect(checkBoard(after)).toEqual([])
  })

  it('deletes a card with its text and its links, and unhooks the other end', () => {
    const after = build([{ op: 'delete', id: 'docs' }], build(retro))
    expectConsistent(after)
    expect(get(after, 'docs').isDeleted).toBe(true)
    expect(get(after, 'flaky-docs').isDeleted).toBe(true)
    expect(get(after, 'flaky').boundElements?.some((bound) => bound.type === 'arrow')).toBe(false)
    // Tombstones stay, so an old copy from a canvas cannot bring them back.
    expect(after.elements.size).toBe(build(retro).elements.size)
  })

  it('deletes a section but can keep what it held', () => {
    const after = build([{ op: 'delete', id: 'good', keepContents: true }], build(retro))
    expect(get(after, 'good').isDeleted).toBe(true)
    expect(get(after, 'ci').isDeleted).toBe(false)
    expect(get(after, 'ci').frameId).toBeNull()
    expectConsistent(after)
  })

  it('updates text, color, shape and suggestions, growing a card for longer text', () => {
    const before = build([{ op: 'card', id: 'a', text: 'Short' }])
    const long = 'A much longer text that needs several lines to fit inside the card without spilling out of it'
    const after = build(
      [
        { op: 'update', id: 'a', text: long, color: 'blue', suggested: true },
        { op: 'update', id: 'a', shape: 'ellipse' },
      ],
      before
    )
    const card = get(after, 'a')
    expect(card.type).toBe('ellipse')
    expect(card.height).toBeGreaterThan(get(before, 'a').height)
    expect(card.backgroundColor).toBe('#a5d8ff')
    expect(card.strokeStyle).toBe('dashed')
    expect(card.customData).toEqual({ maestrly: { by: 'agent', suggested: true } })
    expect(textOf(after, 'a')?.originalText).toBe(long)
    // Several ops on one element in one apply are still one new version.
    expect(card.version).toBe(get(before, 'a').version + 1)
    expect(checkBoard(after)).toEqual([])
  })

  it('lays out a flow left to right along its arrows', () => {
    const board = build([
      { op: 'card', id: 'start', text: 'Start', at: { x: 0, y: 0 } },
      { op: 'card', id: 'review', text: 'Review', at: { x: 0, y: 300 } },
      { op: 'card', id: 'ship', text: 'Ship', at: { x: 0, y: 600 } },
      { op: 'card', id: 'docs', text: 'Docs', at: { x: 0, y: 900 } },
      { op: 'connect', from: 'start', to: 'review' },
      { op: 'connect', from: 'review', to: 'ship' },
      { op: 'connect', from: 'start', to: 'docs' },
      { op: 'connect', from: 'ship', to: 'start', dashed: true },
      { op: 'layout', as: 'flow' },
    ])
    const x = (id: string) => get(board, id).x
    expect(x('start')).toBeLessThan(x('review'))
    expect(x('review')).toBeLessThan(x('ship'))
    expect(x('docs')).toBe(x('review'))
    expect(checkBoard(board)).toEqual([])
    expectConsistent(board)
  })

  it('lays out a row in the order given, like a timeline', () => {
    const board = build([
      { op: 'card', id: 'q3', text: 'Q3' },
      { op: 'card', id: 'q1', text: 'Q1' },
      { op: 'card', id: 'q2', text: 'Q2' },
      { op: 'layout', as: 'row', ids: ['q1', 'q2', 'q3'] },
    ])
    expect(get(board, 'q1').x).toBeLessThan(get(board, 'q2').x)
    expect(get(board, 'q2').x).toBeLessThan(get(board, 'q3').x)
    expect(new Set(['q1', 'q2', 'q3'].map((id) => get(board, id).y)).size).toBe(1)
  })

  it('cancels the whole batch on an invalid op', () => {
    const before = build(retro)
    const result = applyOps(before, {
      baseRevision: 1,
      ops: [
        { op: 'card', id: 'new', text: 'New' },
        { op: 'connect', from: 'new', to: 'missing' },
      ],
      now: NOW,
    })
    expect(result).toEqual({
      ok: false,
      error: { op: 1, code: 'unknown_element', message: 'No element "missing" on the board' },
    })
  })

  it('refuses to create what exists, and reuses the ID of something deleted above its tombstone', () => {
    const board = build(retro)
    const exists = applyOps(board, { baseRevision: 1, ops: [{ op: 'card', id: 'ci', text: 'again' }], now: NOW })
    expect(exists.ok || exists.error.code).toBe('exists')
    const deleted = build([{ op: 'delete', id: 'ci' }], board)
    const reused = build([{ op: 'card', id: 'ci', text: 'again' }], deleted)
    expect(get(reused, 'ci').isDeleted).toBe(false)
    expect(get(reused, 'ci').version).toBe(get(deleted, 'ci').version + 1)
  })

  it('validates ops strictly', () => {
    expect(opsSchema.safeParse([{ op: 'card', id: 'a b', text: 'x' }]).success).toBe(false)
    expect(opsSchema.safeParse([{ op: 'card', id: 'a', text: 'x', colour: 'red' }]).success).toBe(false)
    expect(opsSchema.safeParse([{ op: 'card', id: 'a', text: 'x', color: 'magenta' }]).success).toBe(false)
    expect(opsSchema.safeParse([]).success).toBe(false)
    expect(opsSchema.safeParse(retro).success).toBe(true)
  })

  it('lets the agent see what reads badly and fix it', () => {
    const board = build([
      { op: 'section', id: 'client', title: 'Client' },
      { op: 'section', id: 'backend', title: 'Backend' },
      { op: 'section', id: 'data', title: 'Data' },
      { op: 'card', id: 'web', text: 'Web app (React)', in: 'client', color: 'blue' },
      { op: 'card', id: 'mobile', text: 'Mobile app', in: 'client', color: 'blue' },
      { op: 'card', id: 'api', text: 'API gateway', in: 'backend' },
      { op: 'card', id: 'auth', text: 'Auth service: sessions, OAuth and SSO', in: 'backend' },
      { op: 'card', id: 'db', text: 'Postgres', in: 'data', shape: 'ellipse' },
      { op: 'card', id: 'decide', text: 'Cache?', in: 'data', shape: 'diamond' },
      { op: 'connect', from: 'web', to: 'api', label: 'HTTPS' },
      { op: 'connect', from: 'mobile', to: 'api' },
      { op: 'connect', from: 'api', to: 'auth' },
      { op: 'connect', from: 'api', to: 'db', label: 'SQL' },
      { op: 'connect', from: 'api', to: 'decide', dashed: true },
    ])
    // The dashed arrow to "Cache?" cuts the corner of the wider auth card below the API.
    expect(checkBoard(board)).toEqual([{ kind: 'crossing', ids: ['api-decide', 'auth'] }])
    const fixed = build([{ op: 'move', id: 'auth', in: 'backend', to: { near: 'api', side: 'below' } }], board)
    expect(checkBoard(fixed)).toEqual([])
    expectConsistent(fixed)
  })

  it('pushes neighboring sections away when one grows into them, and keeps arrows in step with their ends', () => {
    const board = build([
      { op: 'section', id: 'left', title: 'Left' },
      { op: 'section', id: 'right', title: 'Right' },
      { op: 'card', id: 'a', text: 'A', in: 'left' },
      { op: 'card', id: 'b', text: 'B', in: 'left' },
      { op: 'card', id: 'c', text: 'C', in: 'right' },
      { op: 'connect', from: 'a', to: 'b' },
    ])
    expect(get(board, 'a-b').frameId).toBe('left')
    const wide = build([{ op: 'layout', in: 'left', as: 'row', gap: 400 }], board)
    expect(get(wide, 'right').x).toBeGreaterThan(get(wide, 'left').x + get(wide, 'left').width)
    expect(get(wide, 'c').x - get(wide, 'right').x).toBe(get(board, 'c').x - get(board, 'right').x)
    expect(checkBoard(wide)).toEqual([])
    const out = build([{ op: 'move', id: 'b', to: { x: -3000, y: 0 } }], board)
    expect(get(out, 'a-b').frameId).toBeNull()
    expect(checkBoard(out)).toEqual([])
  })

  it('moves a card by coordinates into the section it lands in, or out of any', () => {
    const board = build(retro)
    const bad = get(board, 'bad')
    const into = build([{ op: 'move', id: 'ci', to: { x: bad.x + 50, y: bad.y + 200 } }], board)
    expect(get(into, 'ci').frameId).toBe('bad')
    expect(textOf(into, 'ci')!.frameId).toBe('bad')
    const out = build([{ op: 'move', id: 'ci', to: { x: -2000, y: -2000 } }], board)
    expect(get(out, 'ci').frameId).toBeNull()
    // The section it left keeps its size instead of stretching after it.
    expect(get(out, 'good').width).toBe(get(board, 'good').width)
  })

  it('keeps every element in a valid stacking order', () => {
    const board = build(retro)
    const order = orderedElements(board).map((element) => element.id)
    expect(order.indexOf('ci')).toBeLessThan(order.indexOf(textOf(board, 'ci')!.id))
  })
})
