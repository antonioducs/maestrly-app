import { describe, expect, it } from 'vitest'
import { mergeElements } from '../src/board.js'
import { checkBoard } from '../src/check.js'
import { parseIncoming } from '../src/incoming.js'
import { readBoard } from '../src/outline.js'
import { build, get, personEdit } from './helpers.js'

describe('readBoard', () => {
  const board = build([
    { op: 'section', id: 'now', title: 'Now', at: { x: 0, y: 0 } },
    { op: 'card', id: 'login', text: 'Fix login', in: 'now', color: 'red' },
    { op: 'card', id: 'idea', text: 'Maybe SSO?', at: { x: 1200, y: 0 }, suggested: true },
    { op: 'text', id: 'note', text: 'Owners decide on Friday', at: { x: 0, y: -100 } },
    { op: 'connect', from: 'login', to: 'idea', label: 'leads to' },
  ])

  it('lists what the board says without the canvas’s styling', () => {
    const outline = readBoard(board)
    expect(outline.revision).toBe(1)
    expect(outline.sections).toEqual([{ id: 'now', title: 'Now', box: expect.any(Array) }])
    expect(outline.cards).toEqual([
      { id: 'login', text: 'Fix login', shape: 'rectangle', color: 'red', box: expect.any(Array), in: 'now' },
      { id: 'idea', text: 'Maybe SSO?', shape: 'rectangle', box: expect.any(Array), suggested: true },
    ])
    expect(outline.texts).toEqual([{ id: 'note', text: 'Owners decide on Friday', box: expect.any(Array) }])
    expect(outline.links).toEqual([{ id: 'login-idea', from: 'login', to: 'idea', label: 'leads to' }])
    expect(outline.sketches).toEqual([])
    // Far fewer characters than the elements it describes.
    expect(JSON.stringify(outline).length * 4).toBeLessThan(JSON.stringify([...board.elements.values()]).length)
  })

  it('narrows to a region or a section, as when a person drags across part of the board', () => {
    expect(
      readBoard(board, { region: { x: 1100, y: -50, width: 400, height: 300 } }).cards.map((card) => card.id)
    ).toEqual(['idea'])
    expect(readBoard(board, { section: 'now' }).cards.map((card) => card.id)).toEqual(['login'])
  })

  it('marks what a person changed last', () => {
    const merged = mergeElements(board, [personEdit(get(board, 'idea'), { x: 1300 })], 'person').board
    expect(readBoard(merged).cards.find((card) => card.id === 'idea')).toMatchObject({ by: 'person' })
  })
})

describe('checkBoard', () => {
  it('flags an arrow that runs through a card that is not one of its ends', () => {
    const board = build([
      { op: 'card', id: 'a', text: 'A', at: { x: 0, y: 0 } },
      { op: 'card', id: 'middle', text: 'In the way', at: { x: 300, y: 0 } },
      { op: 'card', id: 'b', text: 'B', at: { x: 600, y: 0 } },
      { op: 'connect', from: 'a', to: 'b' },
    ])
    expect(checkBoard(board)).toEqual([{ kind: 'crossing', ids: ['a-b', 'middle'] }])
    const fixed = build([{ op: 'move', id: 'middle', to: { x: 300, y: 300 } }], board)
    expect(checkBoard(fixed)).toEqual([])
  })

  it('flags cards piled on each other', () => {
    const board = build([
      { op: 'card', id: 'a', text: 'A', at: { x: 0, y: 0 } },
      { op: 'card', id: 'b', text: 'B', at: { x: 20, y: 10 } },
    ])
    expect(checkBoard(board)).toEqual([{ kind: 'overlap', ids: ['a', 'b'] }])
  })
})

describe('parseIncoming', () => {
  const drawn = {
    id: 'Xk3v9QpR2mN8bT1wYz4aL',
    type: 'freedraw',
    x: 10,
    y: 20,
    width: 30,
    height: 40,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    roundness: null,
    seed: 1,
    version: 3,
    versionNonce: 99,
    index: 'a0',
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    points: [
      [0, 0],
      [30, 40],
    ],
    pressures: [],
    simulatePressure: true,
    lastCommittedPoint: null,
  }

  it('accepts what a canvas sends and keeps the fields it does not know', () => {
    const result = parseIncoming([drawn])
    expect(result.ok && result.elements[0]?.simulatePressure).toBe(true)
  })

  it('refuses unsafe links, oversized strokes and malformed elements', () => {
    expect(parseIncoming([{ ...drawn, link: 'javascript:alert(1)' }])).toEqual({ ok: false, reason: 'invalid' })
    expect(parseIncoming([{ ...drawn, points: Array.from({ length: 20_001 }, () => [0, 0]) }]).ok).toBe(false)
    expect(parseIncoming([{ ...drawn, id: '../x' }]).ok).toBe(false)
    expect(parseIncoming([{ ...drawn, version: 0 }]).ok).toBe(false)
    expect(parseIncoming({}).ok).toBe(false)
  })
})
