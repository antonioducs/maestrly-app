import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  __resetCwdActivityForTests,
  setOwnedCwdActivity,
  tryAcquireCwdActivity,
} from '../../src/main/cwd-activity-coordinator'
import {
  __resetMigrationLeasesForTests,
  acquireMigrationLease,
  attachMigrationDestinationLease,
} from '../../src/main/conversation-migration/runtime-lease'

beforeEach(freshDb)
afterEach(() => {
  __resetMigrationLeasesForTests()
  __resetCwdActivityForTests()
  closeDb()
})

describe('conversation migration runtime lease', () => {
  it('an idle sibling in the same cwd does not block the lease (prepare gates execution)', () => {
    const workspace = makeWorkspace()
    makeConversation(workspace.id, { id: 'source', cwd: '/tmp/source', mode: 'local' })
    makeConversation(workspace.id, { id: 'sibling', cwd: '/tmp/source', mode: 'local' })

    const lease = acquireMigrationLease('op', 'source', '/tmp/source')
    expect(lease).toBeTruthy()
    // While the lease is active, the sibling cannot start a new turn in the cwd.
    expect(tryAcquireCwdActivity('/tmp/source', 'pty')).toBeNull()
    lease!.release()
  })

  it('tolerates drainable runtimes and blocks new owners until migration finishes', () => {
    const workspace = makeWorkspace()
    makeConversation(workspace.id, { id: 'conv', cwd: '/tmp/source', mode: 'local' })
    expect(setOwnedCwdActivity('pty:conv', '/tmp/source', 'pty', true)).toBe(true)
    const lease = acquireMigrationLease('op', 'conv', '/tmp/source')
    expect(lease).toBeTruthy()
    expect(tryAcquireCwdActivity('/tmp/source', 'chat')).toBeNull()

    expect(attachMigrationDestinationLease('op', '/tmp/destination')).toBe(true)
    const allowed = tryAcquireCwdActivity('/tmp/destination', 'pty', 'other-owner')
    expect(allowed).toBeNull()
    expect(tryAcquireCwdActivity('/tmp/destination', 'pty', 'wrong')).toBeNull()
    lease!.release()
  })
})
