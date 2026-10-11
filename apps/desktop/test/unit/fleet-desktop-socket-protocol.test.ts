import { describe, expect, it } from 'vitest'
import {
  DESKTOP_FRAME_MAX,
  DESKTOP_LINE_MAX,
  DesktopProtocolError,
  FRAME,
  FrameReader,
  LineReader,
  decodeText,
  encodeFrame,
  encodeLine,
  encodeText,
  exitPayload,
  parseExitPayload,
  parseRoleLine,
  parseSizePayload,
  sizePayload,
} from '../../src/main/fleet/instance/desktop/socket-protocol'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('desktop socket text', () => {
  it('round-trips unicode text through base64', () => {
    for (const text of ['', 'plain', 'tab\tand\nnewline', 'ação — 終了 🚀', 'a'.repeat(5000)]) {
      expect(decodeText(encodeText(text))).toBe(text)
    }
    expect(encodeText('hi')).toBe('aGk=')
  })

  it('keeps a byte order mark', () => {
    expect(decodeText(encodeText('﻿bom'))).toBe('﻿bom')
  })

  it('refuses invalid or non-canonical base64', () => {
    for (const bad of ['aGk', 'aGk==', 'a Gk=', 'aGk=\n', 'aG*=', '====', 'aGl=', 'YQ=', 'YQ===', '=YQ=', 'ab-_']) {
      expect(() => decodeText(bad), bad).toThrow(DesktopProtocolError)
    }
  })

  it('refuses text that is not valid UTF-8', () => {
    expect(() => decodeText(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'))).toThrow(DesktopProtocolError)
    expect(() => decodeText(Buffer.from([0xc3, 0x28]).toString('base64'))).toThrow(DesktopProtocolError)
  })
})

describe('desktop socket lines', () => {
  it('encodes fields joined by tabs and ends with a newline', () => {
    expect(encodeLine(['cmd', 'terminal']).toString('utf8')).toBe('cmd\tterminal\n')
    expect(encodeLine(['ok']).toString('utf8')).toBe('ok\n')
  })

  it('refuses fields that would break the framing', () => {
    expect(() => encodeLine(['cmd', 'a\tb'])).toThrow(DesktopProtocolError)
    expect(() => encodeLine(['cmd', 'a\nb'])).toThrow(DesktopProtocolError)
  })

  it('reads whole lines and splits them into fields', () => {
    const reader = new LineReader()
    const input = Buffer.concat([encodeLine(['cmd', 'url', encodeText('https://example.test/')]), encodeLine(['ok'])])
    expect(reader.push(input)).toEqual([['cmd', 'url', 'aHR0cHM6Ly9leGFtcGxlLnRlc3Qv'], ['ok']])
    expect(reader.takeRest().length).toBe(0)
  })

  it('joins a line split across chunks, byte by byte', () => {
    const reader = new LineReader()
    const input = Buffer.concat([encodeLine(['pty', encodeText('term:é:1'), '80', '24']), encodeLine(['ok'])])
    const lines: string[][] = []
    for (const byte of input) lines.push(...reader.push(Buffer.from([byte])))
    expect(lines).toEqual([['pty', encodeText('term:é:1'), '80', '24'], ['ok']])
  })

  it('keeps an incomplete line for the next chunk and hands it back with takeRest', () => {
    const reader = new LineReader()
    expect(reader.push(Buffer.from('cmd\tfil'))).toEqual([])
    expect(reader.push(Buffer.from('es\nrest'))).toEqual([['cmd', 'files']])
    expect(reader.takeRest().toString()).toBe('rest')
    expect(reader.takeRest().length).toBe(0)
  })

  it('stops after the requested number of lines so binary frames that follow are not split', () => {
    const reader = new LineReader()
    const frames = Buffer.concat([
      encodeFrame(FRAME.data, Buffer.from('a\nb\n')),
      encodeFrame(FRAME.data, Buffer.from('c')),
    ])
    const input = Buffer.concat([encodeLine(['pty', 'aWQ=', '80', '24']), frames])
    expect(reader.push(input, 1)).toEqual([['pty', 'aWQ=', '80', '24']])
    expect(reader.takeRest().equals(frames)).toBe(true)
  })

  it('can continue with the lines it held back', () => {
    const reader = new LineReader()
    expect(reader.push(Buffer.from('presenter\t1\nrect\t1\nrect\t2\n'), 1)).toEqual([['presenter', '1']])
    expect(reader.push(Buffer.alloc(0))).toEqual([
      ['rect', '1'],
      ['rect', '2'],
    ])
  })

  it('accepts a line of exactly the limit and refuses one byte more', () => {
    const exact = Buffer.concat([Buffer.alloc(DESKTOP_LINE_MAX, 0x61), Buffer.from('\n')])
    expect(new LineReader().push(exact)).toHaveLength(1)
    const over = Buffer.concat([Buffer.alloc(DESKTOP_LINE_MAX + 1, 0x61), Buffer.from('\n')])
    expect(() => new LineReader().push(over)).toThrow(DesktopProtocolError)
  })

  it('refuses an endless line before it is complete', () => {
    const reader = new LineReader()
    const piece = Buffer.alloc(256 * 1024, 0x61)
    expect(() => {
      for (let sent = 0; sent <= DESKTOP_LINE_MAX; sent += piece.length) reader.push(piece)
    }).toThrow(DesktopProtocolError)
  })
})

describe('desktop socket roles', () => {
  it('parses command roles', () => {
    expect(parseRoleLine(['cmd', 'browser'])).toEqual({ role: 'cmd', command: 'browser', argument: null })
    expect(parseRoleLine(['cmd', 'terminal'])).toEqual({ role: 'cmd', command: 'terminal', argument: null })
    expect(parseRoleLine(['cmd', 'files'])).toEqual({ role: 'cmd', command: 'files', argument: null })
    expect(parseRoleLine(['cmd', 'url', b64('https://example.test/a?x=é')])).toEqual({
      role: 'cmd',
      command: 'url',
      argument: 'https://example.test/a?x=é',
    })
  })

  it('requires an argument for url and forbids it for the other commands', () => {
    expect(() => parseRoleLine(['cmd', 'url'])).toThrow(DesktopProtocolError)
    for (const command of ['browser', 'terminal', 'files']) {
      expect(() => parseRoleLine(['cmd', command, b64('x')])).toThrow(DesktopProtocolError)
    }
    expect(() => parseRoleLine(['cmd', 'url', b64('a'), 'extra'])).toThrow(DesktopProtocolError)
  })

  it('refuses unknown commands and roles', () => {
    expect(() => parseRoleLine(['cmd', 'reboot'])).toThrow(DesktopProtocolError)
    expect(() => parseRoleLine(['cmd'])).toThrow(DesktopProtocolError)
    expect(() => parseRoleLine(['admin'])).toThrow(DesktopProtocolError)
    expect(() => parseRoleLine([''])).toThrow(DesktopProtocolError)
    expect(() => parseRoleLine([])).toThrow(DesktopProtocolError)
  })

  it('refuses an invalid base64 argument', () => {
    expect(() => parseRoleLine(['cmd', 'url', 'not base64!'])).toThrow(DesktopProtocolError)
  })

  it('parses the pty role with its size', () => {
    expect(parseRoleLine(['pty', b64('term:conv:1'), '80', '24'])).toEqual({
      role: 'pty',
      ptyId: 'term:conv:1',
      cols: 80,
      rows: 24,
    })
    expect(parseRoleLine(['pty', b64('t'), '1', '1000'])).toMatchObject({ cols: 1, rows: 1000 })
  })

  it('refuses a malformed pty role', () => {
    for (const bad of [
      ['pty'],
      ['pty', b64('t'), '80'],
      ['pty', b64('t'), '80', '24', 'x'],
      ['pty', '', '80', '24'],
      ['pty', 'bad base64', '80', '24'],
      ['pty', b64('t'), '0', '24'],
      ['pty', b64('t'), '80', '1001'],
      ['pty', b64('t'), '8.5', '24'],
      ['pty', b64('t'), '-1', '24'],
      ['pty', b64('t'), '0x10', '24'],
      ['pty', b64('t'), ' 80', '24'],
      ['pty', b64('t'), '80', ''],
    ]) {
      expect(() => parseRoleLine(bad), bad.join('|')).toThrow(DesktopProtocolError)
    }
  })

  it('parses only version 1 of the presenter role', () => {
    expect(parseRoleLine(['presenter', '1'])).toEqual({ role: 'presenter', version: 1 })
    expect(() => parseRoleLine(['presenter', '2'])).toThrow(DesktopProtocolError)
    expect(() => parseRoleLine(['presenter'])).toThrow(DesktopProtocolError)
    expect(() => parseRoleLine(['presenter', '1', 'x'])).toThrow(DesktopProtocolError)
  })
})

describe('desktop socket frames', () => {
  it('encodes the type, a big-endian length and the data', () => {
    const frame = encodeFrame(FRAME.data, Buffer.from('hi'))
    expect([...frame]).toEqual([1, 0, 0, 0, 2, 0x68, 0x69])
    expect([...encodeFrame(FRAME.size, Buffer.alloc(0))]).toEqual([2, 0, 0, 0, 0])
  })

  it('round-trips frames', () => {
    const reader = new FrameReader()
    const payloads = [Buffer.from('hello'), Buffer.alloc(0), Buffer.from('ação\n\x00\xff', 'latin1')]
    const input = Buffer.concat(payloads.map((payload) => encodeFrame(FRAME.data, payload)))
    const frames = reader.push(input)
    expect(frames.map((frame) => frame.type)).toEqual([1, 1, 1])
    expect(frames.map((frame) => frame.payload.toString('hex'))).toEqual(
      payloads.map((payload) => payload.toString('hex'))
    )
  })

  it('assembles frames split at every byte', () => {
    const reader = new FrameReader()
    const input = Buffer.concat([
      encodeFrame(FRAME.data, Buffer.from('first')),
      encodeFrame(FRAME.size, sizePayload(100, 40)),
      encodeFrame(FRAME.data, Buffer.from('third')),
    ])
    const frames: Array<{ type: number; payload: Buffer }> = []
    for (const byte of input) frames.push(...reader.push(Buffer.from([byte])))
    expect(frames.map((frame) => [frame.type, frame.payload.length])).toEqual([
      [1, 5],
      [2, 4],
      [1, 5],
    ])
    expect(parseSizePayload(frames[1].payload)).toEqual({ cols: 100, rows: 40 })
  })

  it('reads several frames and a partial one from the same chunk', () => {
    const reader = new FrameReader()
    const whole = encodeFrame(FRAME.data, Buffer.from('tail-of-frame'))
    const input = Buffer.concat([
      encodeFrame(FRAME.data, Buffer.from('a')),
      encodeFrame(FRAME.data, Buffer.from('b')),
      whole.subarray(0, 8),
    ])
    expect(reader.push(input).map((frame) => frame.payload.toString())).toEqual(['a', 'b'])
    expect(reader.push(whole.subarray(8)).map((frame) => frame.payload.toString())).toEqual(['tail-of-frame'])
  })

  it('refuses unknown frame types, even before the payload arrives', () => {
    expect(() => new FrameReader().push(Buffer.from([9, 0, 0, 0, 0]))).toThrow(DesktopProtocolError)
    expect(() => new FrameReader().push(Buffer.from([0, 0, 0, 0, 0]))).toThrow(DesktopProtocolError)
    expect(() => encodeFrame(9, Buffer.alloc(0))).toThrow(DesktopProtocolError)
  })

  it('refuses a payload above the limit before reading it', () => {
    const header = Buffer.alloc(5)
    header[0] = FRAME.data
    header.writeUInt32BE(DESKTOP_FRAME_MAX + 1, 1)
    expect(() => new FrameReader().push(header)).toThrow(DesktopProtocolError)
    expect(() => encodeFrame(FRAME.data, Buffer.alloc(DESKTOP_FRAME_MAX + 1))).toThrow(DesktopProtocolError)
    const exact = Buffer.alloc(5)
    exact[0] = FRAME.data
    exact.writeUInt32BE(DESKTOP_FRAME_MAX, 1)
    expect(new FrameReader().push(exact)).toEqual([])
  })

  it('does not accept more input after a protocol error', () => {
    const reader = new FrameReader()
    expect(() => reader.push(Buffer.from([9, 0, 0, 0, 0]))).toThrow(DesktopProtocolError)
    expect(() => reader.push(encodeFrame(FRAME.data, Buffer.from('x')))).toThrow(DesktopProtocolError)
  })
})

describe('desktop socket payloads', () => {
  it('round-trips the terminal size', () => {
    expect(parseSizePayload(sizePayload(80, 24))).toEqual({ cols: 80, rows: 24 })
    expect([...sizePayload(0x0102, 0x0304)]).toEqual([1, 2, 3, 4])
  })

  it('refuses a malformed size', () => {
    expect(() => parseSizePayload(Buffer.alloc(3))).toThrow(DesktopProtocolError)
    expect(() => parseSizePayload(Buffer.alloc(5))).toThrow(DesktopProtocolError)
    expect(() => parseSizePayload(Buffer.from([0, 0, 0, 24]))).toThrow(DesktopProtocolError)
    expect(() => parseSizePayload(Buffer.from([0, 80, 0x13, 0x88]))).toThrow(DesktopProtocolError)
    expect(() => sizePayload(0, 24)).toThrow(DesktopProtocolError)
    expect(() => sizePayload(80, 70000)).toThrow(DesktopProtocolError)
  })

  it('round-trips the exit code and message', () => {
    expect(parseExitPayload(exitPayload(0, 'Process ended'))).toEqual({ code: 0, message: 'Process ended' })
    expect(parseExitPayload(exitPayload(-1, 'ação — 終了'))).toEqual({ code: -1, message: 'ação — 終了' })
    expect(parseExitPayload(exitPayload(130, ''))).toEqual({ code: 130, message: '' })
    expect([...exitPayload(1, 'x').subarray(0, 4)]).toEqual([0, 0, 0, 1])
  })

  it('refuses a malformed exit payload', () => {
    expect(() => parseExitPayload(Buffer.alloc(3))).toThrow(DesktopProtocolError)
    expect(() => parseExitPayload(Buffer.concat([Buffer.alloc(4), Buffer.from([0xff])]))).toThrow(DesktopProtocolError)
  })
})
