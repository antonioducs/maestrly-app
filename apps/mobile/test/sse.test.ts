import { describe, expect, it } from 'vitest'
import { SseParser } from '../src/gateway/sse'

describe('server-sent events parser', () => {
  it('joins a frame split across chunks', () => {
    const parser = new SseParser()
    expect(parser.push('event: fleet\nda')).toEqual([])
    expect(parser.push('ta: {"type":"hello","lastActivitySeq":3}\n\n')).toEqual([
      { event: 'fleet', data: '{"type":"hello","lastActivitySeq":3}' },
    ])
  })
  it('skips comments such as the gateway pings', () => {
    expect(new SseParser().push(': ping\n\n')).toEqual([])
  })
  it('joins multi-line data with newlines', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }])
  })
  it('accepts CRLF line ends', () => {
    expect(new SseParser().push('event: fleet\r\ndata: x\r\n\r\n')).toEqual([{ event: 'fleet', data: 'x' }])
  })
  it('waits for the next chunk when one ends in CR', () => {
    const parser = new SseParser()
    expect(parser.push('data: a\r')).toEqual([])
    expect(parser.push('\n\r\n')).toEqual([{ event: 'message', data: 'a' }])
  })
})
