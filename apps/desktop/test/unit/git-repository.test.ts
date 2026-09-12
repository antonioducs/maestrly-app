import { describe, expect, it } from 'vitest'
import {
  canonicalizeGitRemote,
  gitRemotesMatch,
  pullRequestUrlMatchesCanonicalRepo,
} from '../../src/shared/git-repository'

describe('canonicalizeGitRemote', () => {
  it('matches scp-style SSH and HTTPS URLs for the same repository', () => {
    expect(canonicalizeGitRemote('git@github.com:Org/Repo.git')?.canonicalKey).toBe('github.com/org/repo')
    expect(canonicalizeGitRemote('https://github.com/org/repo.git')?.canonicalKey).toBe('github.com/org/repo')
    expect(gitRemotesMatch('git@github.com:Org/Repo.git', 'https://github.com/org/repo')).toBe(true)
  })

  it('accepts ssh URLs without including the username in the key', () => {
    expect(canonicalizeGitRemote('ssh://git@gitlab.example.com/team/project.git')?.canonicalKey).toBe(
      'gitlab.example.com/team/project'
    )
  })

  it('rejects HTTPS credentials, query strings, fragments and local paths', () => {
    expect(canonicalizeGitRemote('https://user:token@github.com/org/repo.git')).toBeNull()
    expect(canonicalizeGitRemote('https://github.com/org/repo.git?token=secret')).toBeNull()
    expect(canonicalizeGitRemote('/Users/me/repo')).toBeNull()
    expect(canonicalizeGitRemote('file:///tmp/repo')).toBeNull()
  })

  it('limits PR URLs to the canonical repository host and path prefix', () => {
    const canonical = 'gitlab.example.com/team/project'
    expect(
      pullRequestUrlMatchesCanonicalRepo('https://attacker.example/team/project/-/merge_requests/1', canonical)
    ).toBe(false)
    expect(
      pullRequestUrlMatchesCanonicalRepo('https://gitlab.example.com/other/project/-/merge_requests/1', canonical)
    ).toBe(false)
    expect(
      pullRequestUrlMatchesCanonicalRepo('https://gitlab.example.com/team/project-fork/-/merge_requests/1', canonical)
    ).toBe(false)
    expect(
      pullRequestUrlMatchesCanonicalRepo('https://gitlab.example.com/team/project/-/merge_requests/1', canonical)
    ).toBe(true)
  })
})
