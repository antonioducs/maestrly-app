import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  antigravityAccountRoot,
  antigravityFingerprint,
  antigravityLaunchArgs,
  antigravityTokenPath,
  buildAntigravityProcessEnv,
  isStrictlyInside,
  readAntigravityProjectId,
} from '../../src/main/chat/antigravity-subscription/paths'
import { antigravityRuntimeOverrideDir } from '../../src/main/chat/antigravity-subscription/runtime'

let temporary: string
beforeEach(() => {
  temporary = mkdtempSync(path.join(tmpdir(), 'agy-paths-'))
})
afterEach(() => rmSync(temporary, { recursive: true, force: true }))

describe('Antigravity account paths', () => {
  it('keeps each account under userData and rejects traversal', () => {
    expect(antigravityAccountRoot(null, temporary)).toBe(path.join(temporary, 'antigravity', 'accounts', 'default'))
    expect(antigravityAccountRoot('acc_1', temporary)).toBe(path.join(temporary, 'antigravity', 'accounts', 'acc_1'))
    expect(() => antigravityAccountRoot('../x', temporary)).toThrow(/invalid/i)
    expect(() => antigravityAccountRoot('a/b', temporary)).toThrow(/invalid/i)
  })

  it('builds a closed process environment isolated in the account home', () => {
    const root = antigravityAccountRoot(null, temporary)
    const env = buildAntigravityProcessEnv(root, {
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      DISPLAY: ':0',
      OPENAI_API_KEY: 'sk-secret',
      NODE_OPTIONS: '--inspect',
      HOME: '/Users/real',
      GEMINI_API_KEY: 'g-secret',
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      DISPLAY: ':0',
      HOME: root,
      USERPROFILE: root,
      GEMINI_HOME: path.join(root, '.gemini'),
      AGY_ACP_FORCE_FILE_STORAGE: '1',
    })
  })

  it('reads only a valid project id from the token file', () => {
    const root = antigravityAccountRoot(null, temporary)
    expect(readAntigravityProjectId(root)).toBeNull()
    mkdirSync(path.dirname(antigravityTokenPath(root)), { recursive: true })
    writeFileSync(antigravityTokenPath(root), JSON.stringify({ refresh_token: 's', project_id: 'p' }))
    expect(readAntigravityProjectId(root)).toBe('p')
    writeFileSync(antigravityTokenPath(root), '{not json')
    expect(readAntigravityProjectId(root)).toBeNull()
    writeFileSync(antigravityTokenPath(root), JSON.stringify({ refresh_token: 's', project_id: '' }))
    expect(readAntigravityProjectId(root)).toBeNull()
  })

  it('derives a stable fingerprint that does not reveal the project id', () => {
    expect(antigravityFingerprint('p')).toMatch(/^project:[0-9a-f]{32}$/)
    expect(antigravityFingerprint('p')).toBe(antigravityFingerprint('p'))
    expect(antigravityFingerprint('p')).not.toContain('p:')
    expect(antigravityFingerprint('p')).not.toBe(antigravityFingerprint('q'))
  })

  it('passes the Linux uid argument the ACP registry requires', () => {
    expect(antigravityLaunchArgs('linux')).toEqual(['--uid='])
    expect(antigravityLaunchArgs('darwin')).toEqual([])
    expect(antigravityLaunchArgs('win32')).toEqual([])
  })

  it('guards destructive paths and reads the development override', () => {
    expect(isStrictlyInside('/a/b', '/a/b/c')).toBe(true)
    expect(isStrictlyInside('/a/b', '/a/b')).toBe(false)
    expect(isStrictlyInside('/a/b', '/a/bc')).toBe(false)
    expect(isStrictlyInside('/a/b', '/a/b/../c')).toBe(false)
    expect(antigravityRuntimeOverrideDir({ MAESTRLY_ANTIGRAVITY_ACP_DIR: ' /x ' })).toBe('/x')
    expect(antigravityRuntimeOverrideDir({})).toBeNull()
  })
})
