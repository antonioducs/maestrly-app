import { describe, expect, it } from 'vitest'
import { cdpModifiers, editCommand, presentedKeyEvent } from '../../src/main/fleet/instance/desktop/keymap'

const SHIFT = 0x01
const LOCK = 0x02
const CONTROL = 0x04
const MOD1 = 0x08
const MOD2 = 0x10
const MOD4 = 0x40

describe('cdpModifiers', () => {
  it('translates the X11 modifier mask into the CDP bitmask', () => {
    expect(cdpModifiers(0)).toBe(0)
    expect(cdpModifiers(SHIFT)).toBe(8)
    expect(cdpModifiers(CONTROL)).toBe(2)
    expect(cdpModifiers(MOD1)).toBe(1)
    expect(cdpModifiers(MOD4)).toBe(4)
    expect(cdpModifiers(SHIFT | CONTROL | MOD1 | MOD4)).toBe(15)
  })

  it('ignores Caps Lock, Num Lock and mouse button bits', () => {
    expect(cdpModifiers(LOCK)).toBe(0)
    expect(cdpModifiers(MOD2)).toBe(0)
    expect(cdpModifiers(0x100 | 0x400)).toBe(0)
    expect(cdpModifiers(LOCK | SHIFT)).toBe(8)
  })
})

describe('presentedKeyEvent: printable keys', () => {
  it('types a lowercase letter with its US layout code', () => {
    expect(presentedKeyEvent(true, 0x61, 0)).toEqual({
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 0,
      text: 'a',
      unmodifiedText: 'a',
    })
  })

  it('types an uppercase letter held with Shift', () => {
    expect(presentedKeyEvent(true, 0x41, SHIFT)).toMatchObject({
      type: 'keyDown',
      key: 'A',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      modifiers: 8,
      text: 'A',
    })
  })

  it('keeps the case carried by the keysym when Caps Lock is on', () => {
    const event = presentedKeyEvent(true, 0x41, LOCK)
    expect(event).toMatchObject({ type: 'keyDown', key: 'A', code: 'KeyA', modifiers: 0, text: 'A' })
  })

  it('maps digits to Digit codes and their VK', () => {
    expect(presentedKeyEvent(true, 0x35, 0)).toMatchObject({
      key: '5',
      code: 'Digit5',
      windowsVirtualKeyCode: 53,
      text: '5',
    })
  })

  it('maps shifted and unshifted ASCII punctuation to the US key that produces it', () => {
    const cases: [number, string, string, number][] = [
      [0x21, '!', 'Digit1', 49],
      [0x40, '@', 'Digit2', 50],
      [0x29, ')', 'Digit0', 48],
      [0x2d, '-', 'Minus', 189],
      [0x5f, '_', 'Minus', 189],
      [0x3d, '=', 'Equal', 187],
      [0x2b, '+', 'Equal', 187],
      [0x5b, '[', 'BracketLeft', 219],
      [0x7b, '{', 'BracketLeft', 219],
      [0x5d, ']', 'BracketRight', 221],
      [0x7d, '}', 'BracketRight', 221],
      [0x5c, '\\', 'Backslash', 220],
      [0x7c, '|', 'Backslash', 220],
      [0x3b, ';', 'Semicolon', 186],
      [0x3a, ':', 'Semicolon', 186],
      [0x27, "'", 'Quote', 222],
      [0x22, '"', 'Quote', 222],
      [0x60, '`', 'Backquote', 192],
      [0x7e, '~', 'Backquote', 192],
      [0x2c, ',', 'Comma', 188],
      [0x3c, '<', 'Comma', 188],
      [0x2e, '.', 'Period', 190],
      [0x3e, '>', 'Period', 190],
      [0x2f, '/', 'Slash', 191],
      [0x3f, '?', 'Slash', 191],
      [0x20, ' ', 'Space', 32],
    ]
    for (const [keysym, key, code, vk] of cases) {
      expect(presentedKeyEvent(true, keysym, 0), key).toMatchObject({
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        text: key,
      })
    }
  })

  it('covers every printable ASCII keysym with a code', () => {
    for (let keysym = 0x20; keysym <= 0x7e; keysym++) {
      const event = presentedKeyEvent(true, keysym, 0)
      expect(event, String.fromCharCode(keysym)).not.toBeNull()
      expect(event?.code, String.fromCharCode(keysym)).not.toBe('')
      expect(event?.windowsVirtualKeyCode, String.fromCharCode(keysym)).toBeGreaterThan(0)
    }
  })

  it('types Latin-1 characters with an empty code and no virtual key', () => {
    expect(presentedKeyEvent(true, 0xe7, 0)).toEqual({
      type: 'keyDown',
      key: 'ç',
      code: '',
      windowsVirtualKeyCode: 0,
      nativeVirtualKeyCode: 0,
      modifiers: 0,
      text: 'ç',
      unmodifiedText: 'ç',
    })
    expect(presentedKeyEvent(true, 0xa0, 0)).toMatchObject({ key: ' ', code: '', text: ' ' })
    expect(presentedKeyEvent(true, 0xff, 0)).toMatchObject({ key: 'ÿ' })
  })

  it('types Unicode keysyms beyond Latin-1', () => {
    expect(presentedKeyEvent(true, 0x1000101, 0)).toMatchObject({
      type: 'keyDown',
      key: 'ā',
      code: '',
      windowsVirtualKeyCode: 0,
      text: 'ā',
    })
    expect(presentedKeyEvent(true, 0x1000000 + 0x1f600, 0)).toMatchObject({ key: '😀', text: '😀' })
  })

  it('rejects control characters, surrogates and out-of-range Unicode keysyms', () => {
    expect(presentedKeyEvent(true, 0x1000000 + 0x07, 0)).toBeNull()
    expect(presentedKeyEvent(true, 0x1000000 + 0xd800, 0)).toBeNull()
    expect(presentedKeyEvent(true, 0x1000000 + 0x110000, 0)).toBeNull()
    expect(presentedKeyEvent(true, 0x1000000, 0)).toBeNull()
  })

  it('treats the Delete and C1 ranges as having no browser meaning', () => {
    expect(presentedKeyEvent(true, 0x7f, 0)).toBeNull()
    expect(presentedKeyEvent(true, 0x1f, 0)).toBeNull()
    expect(presentedKeyEvent(true, 0x80, 0)).toBeNull()
    expect(presentedKeyEvent(true, 0x9f, 0)).toBeNull()
  })

  it('does not type text for Alt chords but keeps the modifier', () => {
    const event = presentedKeyEvent(true, 0x66, MOD1)
    expect(event).toEqual({
      type: 'rawKeyDown',
      key: 'f',
      code: 'KeyF',
      windowsVirtualKeyCode: 70,
      nativeVirtualKeyCode: 70,
      modifiers: 1,
    })
    expect(event).not.toHaveProperty('text')
    expect(event).not.toHaveProperty('unmodifiedText')
  })

  it('does not type text while Control or Meta is held', () => {
    const control = presentedKeyEvent(true, 0x63, CONTROL)
    expect(control).toMatchObject({ type: 'rawKeyDown', key: 'c', code: 'KeyC', modifiers: 2 })
    expect(control).not.toHaveProperty('text')

    const meta = presentedKeyEvent(true, 0x61, MOD4)
    expect(meta).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 4 })
    expect(meta).not.toHaveProperty('text')

    const controlShift = presentedKeyEvent(true, 0x56, CONTROL | SHIFT)
    expect(controlShift).toMatchObject({ type: 'rawKeyDown', key: 'V', modifiers: 10 })
    expect(controlShift).not.toHaveProperty('text')
  })

  it('still types text with Shift and Caps Lock only', () => {
    expect(presentedKeyEvent(true, 0x21, SHIFT)).toMatchObject({ type: 'keyDown', text: '!', modifiers: 8 })
    expect(presentedKeyEvent(true, 0x61, LOCK | MOD2)).toMatchObject({ type: 'keyDown', text: 'a', modifiers: 0 })
  })

  it('releases a key as keyUp without text', () => {
    const event = presentedKeyEvent(false, 0x61, 0)
    expect(event).toEqual({
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 0,
    })
    expect(event).not.toHaveProperty('text')
    expect(event).not.toHaveProperty('unmodifiedText')
    expect(presentedKeyEvent(false, 0xe7, SHIFT)).toMatchObject({ type: 'keyUp', key: 'ç', modifiers: 8 })
  })
})

describe('presentedKeyEvent: keypad', () => {
  it('types keypad digits and operators at location 3', () => {
    const cases: [number, string, string, number][] = [
      [0xffb0, '0', 'Numpad0', 96],
      [0xffb1, '1', 'Numpad1', 97],
      [0xffb9, '9', 'Numpad9', 105],
      [0xffae, '.', 'NumpadDecimal', 110],
      [0xffab, '+', 'NumpadAdd', 107],
      [0xffad, '-', 'NumpadSubtract', 109],
      [0xffaa, '*', 'NumpadMultiply', 106],
      [0xffaf, '/', 'NumpadDivide', 111],
    ]
    for (const [keysym, key, code, vk] of cases) {
      expect(presentedKeyEvent(true, keysym, 0), code).toEqual({
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers: 0,
        text: key,
        unmodifiedText: key,
        location: 3,
      })
    }
  })

  it('keeps the keypad location on release and does not type text with Control held', () => {
    expect(presentedKeyEvent(false, 0xffb5, 0)).toMatchObject({ type: 'keyUp', code: 'Numpad5', location: 3 })
    const chord = presentedKeyEvent(true, 0xffb5, CONTROL)
    expect(chord).toMatchObject({ type: 'rawKeyDown', code: 'Numpad5', location: 3 })
    expect(chord).not.toHaveProperty('text')
  })
})

describe('presentedKeyEvent: named keys', () => {
  it('presses Enter as a keyDown that types a carriage return', () => {
    expect(presentedKeyEvent(true, 0xff0d, 0)).toEqual({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      modifiers: 0,
      text: '\r',
      unmodifiedText: '\r',
    })
  })

  it('maps the keypad Enter to NumpadEnter at location 3', () => {
    expect(presentedKeyEvent(true, 0xff8d, 0)).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'NumpadEnter',
      windowsVirtualKeyCode: 13,
      text: '\r',
      location: 3,
    })
  })

  it('does not type a carriage return for Enter chords', () => {
    for (const state of [CONTROL, MOD1, MOD4]) {
      const event = presentedKeyEvent(true, 0xff0d, state)
      expect(event, String(state)).toMatchObject({ type: 'rawKeyDown', key: 'Enter' })
      expect(event, String(state)).not.toHaveProperty('text')
    }
    expect(presentedKeyEvent(true, 0xff0d, SHIFT)).toMatchObject({ type: 'keyDown', text: '\r', modifiers: 8 })
  })

  it('releases Enter without text', () => {
    const event = presentedKeyEvent(false, 0xff0d, 0)
    expect(event).toMatchObject({ type: 'keyUp', key: 'Enter', code: 'Enter' })
    expect(event).not.toHaveProperty('text')
  })

  it('presses Tab as a raw key and turns ISO_Left_Tab into Shift+Tab', () => {
    const tab = presentedKeyEvent(true, 0xff09, 0)
    expect(tab).toEqual({
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
      modifiers: 0,
    })

    const backTab = presentedKeyEvent(true, 0xfe20, SHIFT)
    expect(backTab).toMatchObject({
      type: 'rawKeyDown',
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      modifiers: 8,
    })
    // The keysym alone already says Shift even when the server reports a state without it.
    expect(presentedKeyEvent(true, 0xfe20, 0)).toMatchObject({ key: 'Tab', modifiers: 8 })
    expect(presentedKeyEvent(false, 0xfe20, SHIFT)).toMatchObject({ type: 'keyUp', key: 'Tab', modifiers: 8 })
  })

  it('maps navigation and editing keys', () => {
    const cases: [number, string, number][] = [
      [0xff08, 'Backspace', 8],
      [0xff1b, 'Escape', 27],
      [0xffff, 'Delete', 46],
      [0xff50, 'Home', 36],
      [0xff57, 'End', 35],
      [0xff55, 'PageUp', 33],
      [0xff56, 'PageDown', 34],
      [0xff51, 'ArrowLeft', 37],
      [0xff52, 'ArrowUp', 38],
      [0xff53, 'ArrowRight', 39],
      [0xff54, 'ArrowDown', 40],
      [0xff63, 'Insert', 45],
    ]
    for (const [keysym, key, vk] of cases) {
      const event = presentedKeyEvent(true, keysym, 0)
      expect(event, key).toEqual({
        type: 'rawKeyDown',
        key,
        code: key,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers: 0,
      })
      expect(presentedKeyEvent(false, keysym, 0), key).toMatchObject({ type: 'keyUp', key, code: key })
    }
  })

  it('maps arrows with modifiers without text', () => {
    const event = presentedKeyEvent(true, 0xff53, SHIFT | CONTROL)
    expect(event).toMatchObject({ type: 'rawKeyDown', key: 'ArrowRight', modifiers: 10 })
    expect(event).not.toHaveProperty('text')
  })

  it('maps F1 to F12', () => {
    for (let n = 1; n <= 12; n++) {
      expect(presentedKeyEvent(true, 0xffbd + n, 0), `F${n}`).toMatchObject({
        type: 'rawKeyDown',
        key: `F${n}`,
        code: `F${n}`,
        windowsVirtualKeyCode: 111 + n,
        nativeVirtualKeyCode: 111 + n,
      })
    }
  })

  it('maps modifier keys with their side', () => {
    const cases: [number, string, string, number, number][] = [
      [0xffe1, 'Shift', 'ShiftLeft', 16, 1],
      [0xffe2, 'Shift', 'ShiftRight', 16, 2],
      [0xffe3, 'Control', 'ControlLeft', 17, 1],
      [0xffe4, 'Control', 'ControlRight', 17, 2],
      [0xffe9, 'Alt', 'AltLeft', 18, 1],
      [0xffea, 'Alt', 'AltRight', 18, 2],
      [0xffe7, 'Meta', 'MetaLeft', 91, 1],
      [0xffe8, 'Meta', 'MetaRight', 92, 2],
      [0xffeb, 'Meta', 'MetaLeft', 91, 1],
      [0xffec, 'Meta', 'MetaRight', 92, 2],
    ]
    for (const [keysym, key, code, vk, location] of cases) {
      const event = presentedKeyEvent(true, keysym, 0)
      expect(event, code).toEqual({
        type: 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers: 0,
        location,
      })
      expect(presentedKeyEvent(false, keysym, 0), code).toMatchObject({ type: 'keyUp', key, code, location })
    }
  })

  it('maps Caps Lock as a raw key without a side', () => {
    const event = presentedKeyEvent(true, 0xffe5, 0)
    expect(event).toEqual({
      type: 'rawKeyDown',
      key: 'CapsLock',
      code: 'CapsLock',
      windowsVirtualKeyCode: 20,
      nativeVirtualKeyCode: 20,
      modifiers: 0,
    })
  })

  it('returns null for keysyms with no browser meaning', () => {
    expect(presentedKeyEvent(true, 0xfe03, 0)).toBeNull() // ISO_Level3_Shift
    expect(presentedKeyEvent(false, 0xfe03, 0)).toBeNull()
    expect(presentedKeyEvent(true, 0xff7f, 0)).toBeNull() // Num_Lock
    expect(presentedKeyEvent(true, 0xff20, 0)).toBeNull() // Multi_key
    expect(presentedKeyEvent(true, 0xffffff, 0)).toBeNull() // VoidSymbol range
    expect(presentedKeyEvent(true, 0, 0)).toBeNull()
    expect(presentedKeyEvent(true, -1, 0)).toBeNull()
    expect(presentedKeyEvent(true, Number.NaN, 0)).toBeNull()
  })
})

describe('editCommand', () => {
  it('maps the control chords to their edit command', () => {
    expect(editCommand(0x61, CONTROL)).toBe('selectAll')
    expect(editCommand(0x63, CONTROL)).toBe('copy')
    expect(editCommand(0x78, CONTROL)).toBe('cut')
    expect(editCommand(0x76, CONTROL)).toBe('paste')
    expect(editCommand(0x7a, CONTROL)).toBe('undo')
    expect(editCommand(0x7a, CONTROL | SHIFT)).toBe('redo')
    expect(editCommand(0x79, CONTROL)).toBe('redo')
  })

  it('accepts the terminal-style Control+Shift copy and paste and Shift+Insert', () => {
    expect(editCommand(0x43, CONTROL | SHIFT)).toBe('copy')
    expect(editCommand(0x56, CONTROL | SHIFT)).toBe('paste')
    expect(editCommand(0xff63, SHIFT)).toBe('paste')
  })

  it('matches letters case-insensitively', () => {
    expect(editCommand(0x41, CONTROL)).toBe('selectAll')
    expect(editCommand(0x5a, CONTROL | SHIFT)).toBe('redo')
    expect(editCommand(0x5a, CONTROL | LOCK)).toBe('undo')
    expect(editCommand(0x59, CONTROL | LOCK)).toBe('redo')
  })

  it('ignores Num Lock and Caps Lock', () => {
    expect(editCommand(0x63, CONTROL | MOD2)).toBe('copy')
    expect(editCommand(0x76, CONTROL | LOCK)).toBe('paste')
  })

  it('returns null for plain keys and unrelated chords', () => {
    expect(editCommand(0x61, 0)).toBeNull()
    expect(editCommand(0x63, SHIFT)).toBeNull()
    expect(editCommand(0x62, CONTROL)).toBeNull()
    expect(editCommand(0x41, CONTROL | SHIFT)).toBeNull()
    expect(editCommand(0x58, CONTROL | SHIFT)).toBeNull()
    expect(editCommand(0x59, CONTROL | SHIFT)).toBeNull()
    expect(editCommand(0xff63, 0)).toBeNull()
    expect(editCommand(0xff63, CONTROL)).toBeNull()
    expect(editCommand(0xff0d, CONTROL)).toBeNull()
    expect(editCommand(0xffe3, CONTROL)).toBeNull()
    // A keysym whose low 16 bits happen to spell a letter is not that letter.
    expect(editCommand(0x10063, CONTROL)).toBeNull()
  })

  it('returns null when Alt or Meta is held', () => {
    expect(editCommand(0x63, CONTROL | MOD1)).toBeNull()
    expect(editCommand(0x63, CONTROL | MOD4)).toBeNull()
    expect(editCommand(0x76, CONTROL | SHIFT | MOD1)).toBeNull()
    expect(editCommand(0xff63, SHIFT | MOD4)).toBeNull()
    expect(editCommand(0x63, MOD4)).toBeNull()
  })
})
