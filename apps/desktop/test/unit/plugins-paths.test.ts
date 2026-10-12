import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pluginKeyHash, pluginLayout } from '../../src/main/plugins/layout'
import {
  assertRealpathInside,
  isSafeTreePath,
  parsePluginRelativePath,
  resolveInsideRoot,
} from '../../src/main/plugins/paths'

describe('plugin-relative paths', () => {
  it.each([
    ['./skills', ['skills']],
    ['./a/b.json', ['a', 'b.json']],
    ['.', []],
    ['./', []],
    ['./a/./b', ['a', 'b']],
  ])('accepts %s', (value, segments) => {
    expect(parsePluginRelativePath(value)).toEqual({ ok: true, segments })
  })

  it.each([
    ['skills', 'not-relative'],
    ['/etc/passwd', 'not-relative'],
    ['../x', 'not-relative'],
    ['./../x', 'escapes'],
    ['./a/../../x', 'escapes'],
    ['./a\\b', 'invalid'],
    ['./a\u0000b', 'invalid'],
    ['C:/x', 'not-relative'],
  ])('rejects %s', (value, reason) => {
    expect(parsePluginRelativePath(value)).toEqual({ ok: false, reason })
  })

  it('resolves .. that stays inside the root', () => {
    expect(parsePluginRelativePath('./a/../b')).toEqual({ ok: true, segments: ['b'] })
  })

  it('rejects unsafe tree paths', () => {
    for (const p of ['', '/a', 'a/../b', 'a//b', 'a\\b', '.git/config', 'a/.git/x', 'x\u0000', 'a/./b'])
      expect(isSafeTreePath(p)).toBe(false)
    for (const p of ['a', 'a/b.md', '.codex-plugin/plugin.json', 'skills/x/SKILL.md'])
      expect(isSafeTreePath(p)).toBe(true)
  })

  it('detects symlink escapes with realpath', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'plg-'))
    const outside = mkdtempSync(path.join(os.tmpdir(), 'plg-out-'))
    writeFileSync(path.join(outside, 'secret'), 'x')
    mkdirSync(path.join(root, 'bin'))
    writeFileSync(path.join(root, 'bin', 'ok'), 'y')
    symlinkSync(path.join(outside, 'secret'), path.join(root, 'bin', 'tool'))
    await expect(assertRealpathInside(root, path.join(root, 'bin', 'tool'))).rejects.toThrow('path-unsafe')
    await expect(assertRealpathInside(root, path.join(root, 'bin', 'ok'))).resolves.toMatch(/ok$/)
    expect(() => resolveInsideRoot(root, ['..', 'x'])).toThrow('path-unsafe')
    expect(resolveInsideRoot(root, ['bin', 'ok'])).toBe(path.join(root, 'bin', 'ok'))
  })
})

describe('plugin layout', () => {
  it('derives stable directories under the plugins root', () => {
    const layout = pluginLayout('/data/plugins')
    const hash = pluginKeyHash('demo@market')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
    expect(pluginKeyHash('demo@market')).toBe(hash)
    expect(layout.packageDir(hash, 'abc')).toBe(path.join('/data/plugins/packages', hash, 'abc'))
    expect(layout.data(hash)).toBe(path.join('/data/plugins/data', hash))
    expect(layout.source('mkt_1')).toBe(path.join('/data/plugins/sources/mkt_1'))
    expect(layout.extSource('h')).toBe(path.join('/data/plugins/sources/ext/h'))
    expect(layout.staging()).toBe(path.join('/data/plugins/.staging'))
  })
})
