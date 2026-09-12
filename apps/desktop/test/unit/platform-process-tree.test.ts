import { describe, expect, it } from 'vitest'
import { descendantsOf, parsePsTreeLines, parseWindowsTreeJson } from '../../src/main/platform'

/** Pure ps/CIM parsers and descendantsOf BFS: ignore malformed rows, return an empty map on JSON failure, visit each node once despite cycles, exclude other roots, and sort descendants. */

describe('parsePsTreeLines', () => {
  it('parses pid/ppid and ignores malformed rows', () => {
    const out = parsePsTreeLines('  700   1\n  701   700\n  702   701\n  junk\n\n  703\n')
    expect(out).toEqual(
      new Map([
        [700, 1],
        [701, 700],
        [702, 701],
      ])
    )
  })

  it('returns an empty map for empty stdout', () => {
    expect(parsePsTreeLines('').size).toBe(0)
  })
})

describe('parseWindowsTreeJson', () => {
  it('parses the ConvertTo-Json array (Win32_Process)', () => {
    const out = parseWindowsTreeJson(
      '[{"ProcessId":700,"ParentProcessId":1},{"ProcessId":701,"ParentProcessId":700}]'
    )
    expect(out).toEqual(
      new Map([
        [700, 1],
        [701, 700],
      ])
    )
  })

  it('accepts a single object and ignores invalid rows or JSON', () => {
    expect(parseWindowsTreeJson('{"ProcessId":700,"ParentProcessId":1}')).toEqual(new Map([[700, 1]]))
    expect(parseWindowsTreeJson('not json').size).toBe(0)
    expect(parseWindowsTreeJson('').size).toBe(0)
  })
})

describe('descendantsOf', () => {
  const tree = new Map<number, number>([
    [700, 1], // root
    [701, 700], // filho direto
    [702, 700], // filho direto
    [703, 701], // neto (via 701)
    [704, 703], // bisneto
    [705, 1], // outside the tree
  ])

  it('expands and sorts the complete tree using BFS', () => {
    const out = descendantsOf(tree, [700])
    expect(out.get(700)).toEqual([701, 702, 703, 704])
  })

  it('ignores unknown roots and does not revisit cycles', () => {
    const cyclic = new Map<number, number>([
      [700, 701],
      [701, 700], // ciclo 700↔701
      [702, 700],
    ])
    const out = descendantsOf(cyclic, [700, 999])
    expect(out.get(700)).toEqual([701, 702])
    expect(out.get(999)).toEqual([])
  })

  it('a root never appears as another root\'s descendant, avoiding duplicate records', () => {
    const out = descendantsOf(tree, [700, 701])
    // PID 701 is a child of 700 but also a root, so the 700 tree excludes that subtree.
    expect(out.get(700)).toEqual([702])
    // The 701 tree contains only its own descendants.
    expect(out.get(701)).toEqual([703, 704])
  })

  it('returns an empty map when there are no roots', () => {
    expect(descendantsOf(tree, []).size).toBe(0)
  })
})
