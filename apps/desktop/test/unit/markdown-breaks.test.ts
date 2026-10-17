import { describe, expect, it } from 'vitest'
import { remarkSoftBreaks } from '../../src/renderer/lib/markdown-breaks'

interface Node {
  type: string
  value?: string
  children?: Node[]
}

const text = (value: string): Node => ({ type: 'text', value })
const parent = (type: string, children: Node[]): Node => ({ type, children })

describe('remarkSoftBreaks', () => {
  it('turns each line break of a paragraph into a hard break', () => {
    const paragraph = parent('paragraph', [text('Context:\nfirst line\r\nsecond line')])

    remarkSoftBreaks()(parent('root', [paragraph]))

    expect(paragraph.children).toEqual([
      text('Context:'),
      { type: 'break' },
      text('first line'),
      { type: 'break' },
      text('second line'),
    ])
  })

  it('reaches text inside emphasis and links and leaves code alone', () => {
    const strong = parent('strong', [text('a\nb')])
    const inlineCode: Node = { type: 'inlineCode', value: 'x\ny' }
    const code: Node = { type: 'code', value: 'one\ntwo' }
    const tree = parent('root', [parent('paragraph', [strong, inlineCode]), code])

    remarkSoftBreaks()(tree)

    expect(strong.children).toEqual([text('a'), { type: 'break' }, text('b')])
    expect(inlineCode.value).toBe('x\ny')
    expect(code.value).toBe('one\ntwo')
  })

  it('adds no empty text where a line ends the node', () => {
    const paragraph = parent('paragraph', [text('end\n'), parent('emphasis', [text('next')])])

    remarkSoftBreaks()(paragraph)

    expect(paragraph.children).toEqual([text('end'), { type: 'break' }, parent('emphasis', [text('next')])])
  })
})
