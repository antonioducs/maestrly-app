import { describe, expect, it } from 'vitest'
import {
  BROWSER_STREAM_LIMITS,
  browserStreamCursor,
  isBrowserStreamId,
  parseBrowserStreamInput,
  parseBrowserStreamOptions,
} from '../../src/shared/browser-stream'

describe('remote browser stream options', () => {
  it('asks for video only when the window says it plays it', () => {
    expect(parseBrowserStreamOptions({ video: true })).toEqual({ video: true })
    expect(parseBrowserStreamOptions({ video: false })).toEqual({ video: false })
    expect(parseBrowserStreamOptions({ video: true, extra: 1 })).toEqual({ video: true })
    for (const value of [undefined, null, 'video', 1, [], { video: 'yes' }])
      expect(parseBrowserStreamOptions(value)).toEqual({})
  })
})

describe('remote browser stream input', () => {
  it('keeps well-formed mouse, wheel, key, text, edit and focus input', () => {
    const mouse = {
      type: 'mouse',
      action: 'down',
      x: 10.5,
      y: 20,
      button: 'left',
      buttons: 1,
      clickCount: 2,
      modifiers: 8,
    }
    expect(parseBrowserStreamInput(mouse)).toEqual(mouse)
    expect(parseBrowserStreamInput({ type: 'wheel', x: 1, y: 2, deltaX: 0, deltaY: -120, modifiers: 0 })).toEqual({
      type: 'wheel',
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY: -120,
      modifiers: 0,
    })
    expect(
      parseBrowserStreamInput({
        type: 'key',
        action: 'down',
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        modifiers: 0,
        location: 0,
        autoRepeat: false,
        commands: ['deleteToBeginningOfLine'],
      })
    ).toMatchObject({ type: 'key', commands: ['deleteToBeginningOfLine'] })
    expect(
      parseBrowserStreamInput({
        type: 'key',
        action: 'down',
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        modifiers: 0,
        location: 0,
        autoRepeat: false,
        text: '\r',
      })
    ).toMatchObject({ text: '\r' })
    expect(parseBrowserStreamInput({ type: 'text', text: 'ação é' })).toEqual({ type: 'text', text: 'ação é' })
    expect(parseBrowserStreamInput({ type: 'edit', command: 'selectAll' })).toEqual({
      type: 'edit',
      command: 'selectAll',
    })
    expect(parseBrowserStreamInput({ type: 'focus', focused: true })).toEqual({ type: 'focus', focused: true })
  })

  it('drops extra fields instead of passing them to the page', () => {
    expect(parseBrowserStreamInput({ type: 'text', text: 'a', injected: 1 })).toEqual({ type: 'text', text: 'a' })
  })

  it('refuses malformed or oversized input', () => {
    const key = {
      type: 'key',
      action: 'down',
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      modifiers: 0,
      location: 0,
      autoRepeat: false,
    }
    for (const bad of [
      null,
      'click',
      { type: 'mouse', action: 'down', x: Number.NaN, y: 0, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      { type: 'mouse', action: 'drag', x: 0, y: 0, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
      { type: 'mouse', action: 'down', x: 0, y: 0, button: 'left', buttons: 1, clickCount: 1, modifiers: 16 },
      { type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: Infinity, modifiers: 0 },
      { ...key, text: 'a' },
      { ...key, commands: ['insertHTML'] },
      { ...key, key: '' },
      { ...key, keyCode: 256 },
      { type: 'text', text: '' },
      { type: 'text', text: 'x'.repeat(BROWSER_STREAM_LIMITS.maxTextInputChars + 1) },
      { type: 'edit', command: 'paste' },
      { type: 'focus', focused: 'yes' },
      { type: 'eval', expression: '1' },
    ])
      expect(parseBrowserStreamInput(bad)).toBeNull()
  })

  it('maps Electron cursor types to the CSS cursors the window accepts', () => {
    expect(browserStreamCursor('pointer')).toBe('pointer')
    expect(browserStreamCursor('nodrop')).toBe('no-drop')
    expect(browserStreamCursor('m-panning-vertical')).toBe('all-scroll')
    expect(browserStreamCursor('custom')).toBe('default')
    expect(browserStreamCursor('url(javascript:alert(1))')).toBe('default')
    expect(browserStreamCursor(undefined)).toBe('default')
  })

  it('accepts only stream ids of the shape the host hands out', () => {
    expect(isBrowserStreamId('abcdefghijklmnopqrstuv')).toBe(true)
    expect(isBrowserStreamId('short')).toBe(false)
    expect(isBrowserStreamId('../../etc/passwd-0123456789')).toBe(false)
    expect(isBrowserStreamId(42)).toBe(false)
  })
})
