import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { realFileSystem } from '../../src/main/real-fs'

describe('real file system', () => {
  it("is Electron's file system without ASAR support inside Electron", () => {
    const original = { promises: {} }
    const load = vi.fn(() => original)
    expect(realFileSystem({ electron: '44.7.2' }, load)).toBe(original)
    expect(load).toHaveBeenCalledWith('original-fs')
  })

  it("is Node's own file system anywhere else", () => {
    const load = vi.fn()
    expect(realFileSystem({}, load)).toBe(fs)
    expect(load).not.toHaveBeenCalled()
  })
})
