import { describe, expect, it } from 'vitest'
import { redactTokens } from '../../src/main/pii-scrub'
import { isSafeProjectName, validateGitRemoteUrl } from '../../src/shared/project-setup'

describe('redactTokens — Git URLs', () => {
  it('redacts HTTP(S) userinfo and sensitive query parameters without exposing tokens', () => {
    const value = redactTokens('clone https://alice:s3cr3t@example.com/org/repo.git?access_token=abc123')
    expect(value).toBe('clone https://***@example.com/org/repo.git?access_token=***')
    expect(value).not.toContain('alice')
    expect(value).not.toContain('s3cr3t')
    expect(value).not.toContain('abc123')
  })

  it('preserves scp-like SSH URLs and legitimate paths containing token without assignment', () => {
    expect(redactTokens('git@host:org/token-tools.git')).toBe('git@host:org/token-tools.git')
    expect(validateGitRemoteUrl('git@host:org/repo.git')).toEqual({ valid: true })
    expect(validateGitRemoteUrl('ssh://git@host/org/repo.git')).toEqual({ valid: true })
    expect(validateGitRemoteUrl('remote.git')).toEqual({ valid: true })
  })

  it('rejects nonportable names before touching the filesystem', () => {
    for (const name of ['foo:bar', 'foo?bar', 'foo\nbar', 'foo\tbar']) {
      expect(isSafeProjectName(name)).toBe(false)
    }
    expect(isSafeProjectName('valid project')).toBe(true)
  })

  it('rejects HTTPS credentials and sensitive queries before spawning', () => {
    expect(validateGitRemoteUrl('https://alice:secret@host/repo.git')).toEqual({
      valid: false,
      code: 'embedded-credentials',
    })
    expect(validateGitRemoteUrl('https://host/repo.git?token=secret')).toEqual({
      valid: false,
      code: 'embedded-credentials',
    })
    expect(validateGitRemoteUrl('git://user:secret@host/repo')).toEqual({
      valid: false,
      code: 'embedded-credentials',
    })
    expect(validateGitRemoteUrl('https://host/repo?X-Amz-Signature=secret')).toEqual({
      valid: false,
      code: 'embedded-credentials',
    })
    expect(validateGitRemoteUrl('file://user:secret@host/repo.git')).toEqual({
      valid: false,
      code: 'embedded-credentials',
    })
    expect(validateGitRemoteUrl('git@host:org/repo.git?token=secret')).toEqual({
      valid: false,
      code: 'embedded-credentials',
    })
  })
})
