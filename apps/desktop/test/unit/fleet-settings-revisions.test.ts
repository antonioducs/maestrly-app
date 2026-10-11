import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { freshDb, closeDb, restartDb } from '../helpers/db'
import { setAppSetting, setAppFlag } from '../../src/main/store/app-settings'
import {
  settingsRevision,
  touchSettingsRevision,
  withSettingsRevision,
  observeSettingsRevision,
} from '../../src/main/fleet/instance/settings/revisions'
beforeEach(freshDb)
afterEach(closeDb)
describe('environment settings revisions', () => {
  it('persists opaque revisions across restarts', () => {
    const initial = settingsRevision('accounts')
    expect(initial).toMatch(/^[0-9a-f-]{36}$/)
    restartDb()
    expect(settingsRevision('accounts')).toBe(initial)
    touchSettingsRevision('accounts')
    expect(settingsRevision('accounts')).not.toBe(initial)
  })
  it('serializes competing writers and leaves failures unchanged', async () => {
    const initial = settingsRevision('skill:example')
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = withSettingsRevision('skill:example', initial, () => wait)
    const second = withSettingsRevision('skill:example', initial, () => {
      throw new Error('must not run')
    })
    const rejected = expect(second).rejects.toMatchObject({ code: 'CONFLICT' })
    release()
    await first
    await rejected
    const current = settingsRevision('skill:example')
    await expect(
      withSettingsRevision('skill:example', current, () => {
        throw new Error('write failed')
      })
    ).rejects.toThrow('write failed')
    expect(settingsRevision('skill:example')).toBe(current)
  })
  it('invalidates local and import edits at the shared store boundary', () => {
    for (const [setting, resource, value] of [
      ['chat.apiKey.provider', 'accounts', 'enc:fixture-key'],
      ['chat.subscriptionDefaultLabels', 'accounts', '{"codex-subscription":"Work"}'],
      ['chat.mcpServer.server', 'mcp:server', 'enc:fixture-transport'],
      ['chat.providers', 'accounts', '[{"id":"provider"}]'],
      ['chat.hiddenModels', 'models:provider', '{"provider":["hidden"]}'],
      ['chat.mcpServers', 'mcp:server', '[{"id":"server"}]'],
      ['chat.skills.disabled', 'skill:example', '["example"]'],
      ['chat.skills.groups.v1', 'skill-groups', '[]'],
      ['runtimeAssets.codexReleases', 'runtime:codex', '{"automatic":false}'],
    ]) {
      const revision = settingsRevision(resource)
      setAppSetting(setting, value)
      expect(settingsRevision(resource)).not.toBe(revision)
      const after = settingsRevision(resource)
      setAppSetting(setting, value)
      expect(settingsRevision(resource)).toBe(after)
    }
    const revision = settingsRevision('preferences')
    setAppFlag('chat.imageGen', false)
    expect(settingsRevision('preferences')).not.toBe(revision)
  })
  it('observes external content changes without returning content hashes', () => {
    const initial = observeSettingsRevision('skill:example', 'first')
    expect(observeSettingsRevision('skill:example', 'first')).toBe(initial)
    expect(observeSettingsRevision('skill:example', 'second')).not.toBe(initial)
  })
})
