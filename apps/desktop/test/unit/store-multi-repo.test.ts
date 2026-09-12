import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { freshDb, closeDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  deleteConversation,
  getConversation,
  insertConvRepos,
  listConvIdsByWorkspaceRepo,
  listConvRepos,
  touchConversation,
  type ConvRepo,
} from '../../src/main/store'

beforeEach(freshDb)
afterEach(closeDb)

function repo(workspaceId: string, n: number): ConvRepo {
  return {
    workspaceId,
    repoTop: `/repo-${n}`,
    branch: `branch-${n}`,
    base: 'main',
    worktreePath: `/worktree-${n}`,
    linkName: `repo-${n}`,
  }
}

describe('store multi-repo conversations', () => {
  it('inserts and lists conversation repos by persisted position', () => {
    const primary = makeWorkspace()
    const secondary = makeWorkspace()
    const conv = makeConversation(primary.id, { isMulti: 1 })
    const repos = [repo(primary.id, 1), repo(secondary.id, 2), repo(secondary.id, 3)]

    insertConvRepos(conv.id, repos)

    expect(listConvRepos(conv.id)).toEqual(repos)
  })

  it('attaches repos when reading a multi-repo conversation', () => {
    const primary = makeWorkspace()
    const secondary = makeWorkspace()
    const conv = makeConversation(primary.id, { isMulti: 1 })
    const repos = [repo(primary.id, 1), repo(secondary.id, 2)]

    insertConvRepos(conv.id, repos)

    expect(getConversation(conv.id)?.repos).toEqual(repos)
  })

  it('lists distinct conversation ids that include a workspace repo', () => {
    const primary = makeWorkspace()
    const secondary = makeWorkspace()
    const conv = makeConversation(primary.id, { isMulti: 1 })

    insertConvRepos(conv.id, [repo(primary.id, 1), repo(secondary.id, 2), repo(secondary.id, 3)])

    expect(listConvIdsByWorkspaceRepo(secondary.id)).toEqual([conv.id])
  })

  it('cascades conversation repo rows on deleteConversation', () => {
    const primary = makeWorkspace()
    const secondary = makeWorkspace()
    const conv = makeConversation(primary.id, { isMulti: 1 })

    insertConvRepos(conv.id, [repo(primary.id, 1), repo(secondary.id, 2)])
    deleteConversation(conv.id)

    expect(listConvRepos(conv.id)).toEqual([])
    expect(getConversation(conv.id)).toBeUndefined()
  })

  it('updates last_activity_at via touchConversation', () => {
    const ws = makeWorkspace()
    const conv = makeConversation(ws.id, { lastActivityAt: 10 })

    touchConversation(conv.id, 123_456)

    expect(getConversation(conv.id)?.lastActivityAt).toBe(123_456)
  })
})
