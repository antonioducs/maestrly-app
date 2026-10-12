import { describe, expect, it } from 'vitest'
import { keyUpInput, routeKeyDown, type KeyEventLike } from '../../src/renderer/lib/remote-browser-keys'

const CONTROL = 2
const SHIFT = 8
const ALT = 1

function key(init: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return {
    code: '',
    keyCode: 0,
    location: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...init,
  }
}

describe('remote browser keys', () => {
  it('sends a character key to the page and leaves its character to the text field', () => {
    const route = routeKeyDown(key({ key: 'a', code: 'KeyA', keyCode: 65 }), 'mac')
    expect(route).toEqual({
      route: 'page',
      typed: true,
      input: {
        type: 'key',
        action: 'down',
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        modifiers: 0,
        location: 0,
        autoRepeat: false,
      },
    })
  })

  it('leaves dead keys and compositions to the text field', () => {
    expect(routeKeyDown(key({ key: 'Dead', code: 'Quote', keyCode: 222 }), 'linux')).toEqual({ route: 'compose' })
    expect(routeKeyDown(key({ key: 'é', code: 'KeyE', isComposing: true }), 'mac')).toEqual({ route: 'compose' })
    expect(routeKeyDown(key({ key: 'Process', keyCode: 229 }), 'win')).toEqual({ route: 'compose' })
  })

  it('types Enter and Space through their key, with the text the page expects', () => {
    expect(routeKeyDown(key({ key: 'Enter', code: 'Enter', keyCode: 13 }), 'linux')).toMatchObject({
      route: 'page',
      typed: false,
      input: { key: 'Enter', keyCode: 13, text: '\r' },
    })
    expect(routeKeyDown(key({ key: ' ', code: 'Space', keyCode: 32 }), 'mac')).toMatchObject({
      route: 'page',
      typed: false,
      input: { key: ' ', text: ' ' },
    })
    expect(routeKeyDown(key({ key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true }), 'mac')).toMatchObject({
      route: 'page',
      typed: false,
      input: { key: 'Tab', modifiers: SHIFT },
    })
  })

  it('maps the Mac editing shortcuts to their Linux keys', () => {
    expect(
      routeKeyDown(key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, shiftKey: true }), 'mac')
    ).toMatchObject({
      route: 'page',
      input: { key: 'Home', code: 'Home', keyCode: 36, modifiers: SHIFT },
    })
    expect(routeKeyDown(key({ key: 'ArrowDown', code: 'ArrowDown', metaKey: true }), 'mac')).toMatchObject({
      input: { key: 'End', modifiers: CONTROL },
    })
    expect(routeKeyDown(key({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }), 'mac')).toMatchObject({
      input: { key: 'ArrowRight', keyCode: 39, modifiers: CONTROL },
    })
    expect(routeKeyDown(key({ key: 'Backspace', code: 'Backspace', metaKey: true }), 'mac')).toMatchObject({
      input: { key: 'Backspace', keyCode: 8, modifiers: 0, commands: ['deleteToBeginningOfLine'] },
    })
    // Option with a character key types a character; it is no Alt shortcut on the host.
    expect(routeKeyDown(key({ key: '™', code: 'Digit2', altKey: true }), 'mac')).toMatchObject({
      route: 'page',
      typed: true,
      input: { modifiers: 0 },
    })
  })

  it('takes only the listed Command/Control shortcuts from the app', () => {
    expect(routeKeyDown(key({ key: 'c', code: 'KeyC', metaKey: true }), 'mac')).toEqual({ route: 'copy', cut: false })
    expect(routeKeyDown(key({ key: 'x', code: 'KeyX', ctrlKey: true }), 'linux')).toEqual({ route: 'copy', cut: true })
    expect(routeKeyDown(key({ key: 'v', code: 'KeyV', ctrlKey: true }), 'win')).toEqual({ route: 'paste' })
    expect(routeKeyDown(key({ key: 'a', code: 'KeyA', metaKey: true }), 'mac')).toEqual({
      route: 'edit',
      command: 'selectAll',
    })
    expect(routeKeyDown(key({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true }), 'mac')).toEqual({
      route: 'edit',
      command: 'redo',
    })
    expect(routeKeyDown(key({ key: 'y', code: 'KeyY', ctrlKey: true }), 'win')).toEqual({
      route: 'edit',
      command: 'redo',
    })
    expect(routeKeyDown(key({ key: 'b', code: 'KeyB', keyCode: 66, metaKey: true }), 'mac')).toMatchObject({
      route: 'page',
      typed: false,
      input: { key: 'b', code: 'KeyB', keyCode: 66, modifiers: CONTROL },
    })
    expect(routeKeyDown(key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }), 'linux')).toMatchObject({
      input: { modifiers: CONTROL | SHIFT },
    })
    // Everything else stays with the app: its own shortcuts keep working over the surface.
    expect(routeKeyDown(key({ key: 't', code: 'KeyT', metaKey: true }), 'mac')).toEqual({ route: 'app' })
    expect(routeKeyDown(key({ key: 'w', code: 'KeyW', ctrlKey: true }), 'linux')).toEqual({ route: 'app' })
    expect(routeKeyDown(key({ key: 'Meta', code: 'MetaLeft' }), 'mac')).toEqual({ route: 'app' })
  })

  it('runs the browser shortcuts on the remote browser', () => {
    expect(routeKeyDown(key({ key: 'l', code: 'KeyL', metaKey: true }), 'mac')).toEqual({
      route: 'browser',
      action: 'focus-address',
    })
    expect(routeKeyDown(key({ key: 'r', code: 'KeyR', ctrlKey: true }), 'linux')).toEqual({
      route: 'browser',
      action: 'reload',
    })
    expect(routeKeyDown(key({ key: 'F5', code: 'F5' }), 'win')).toEqual({ route: 'browser', action: 'reload' })
    expect(routeKeyDown(key({ key: '[', code: 'BracketLeft', metaKey: true }), 'mac')).toEqual({
      route: 'browser',
      action: 'back',
    })
    expect(routeKeyDown(key({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }), 'linux')).toEqual({
      route: 'browser',
      action: 'forward',
    })
  })

  it('sends Alt shortcuts of Linux and Windows keyboards to the page', () => {
    expect(routeKeyDown(key({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }), 'linux')).toMatchObject({
      route: 'page',
      input: { key: 'ArrowUp', modifiers: ALT },
    })
  })

  it('releases a key as the page saw it go down', () => {
    const down = routeKeyDown(key({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }), 'mac')
    if (down.route !== 'page') throw new Error('Expected a page key')
    expect(keyUpInput(down.input)).toEqual({
      type: 'key',
      action: 'up',
      key: 'Home',
      code: 'Home',
      keyCode: 36,
      modifiers: 0,
      location: 0,
      autoRepeat: false,
    })
  })
})
