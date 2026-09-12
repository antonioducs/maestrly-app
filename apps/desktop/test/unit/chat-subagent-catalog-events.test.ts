import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const helper = readFileSync(new URL('../../src/renderer/lib/subagent-catalog-events.ts', import.meta.url), 'utf8')
const chatViewSource = readFileSync(new URL('../../src/renderer/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const settingsSource = readFileSync(
  new URL('../../src/renderer/components/chat/subagent-profiles/SubagentProfilesSettings.tsx', import.meta.url),
  'utf8'
)
const plusMenuSource = readFileSync(
  new URL('../../src/renderer/components/chat/ChatPlusMenu.tsx', import.meta.url),
  'utf8'
)
const conversationSource = readFileSync(
  new URL('../../src/renderer/components/chat/subagent-profiles/ConversationSubagentProfiles.tsx', import.meta.url),
  'utf8'
)

describe('subagent catalog: unified invalidation (structural contract)', () => {
  it('a single helper centralizes the event without scattered string literals', () => {
    expect(helper).toContain("'maestrly:subagent-profiles-changed'")
    expect(helper).toContain('notifySubagentProfilesChanged')
    expect(helper).toContain('subscribeSubagentProfilesChanged')
    expect(helper).toContain('window.dispatchEvent(new Event(')
    expect(helper).toContain('window.addEventListener')
  })

  it('ChatView subscribes through the helper and guards against late responses from the previous conversation', () => {
    expect(chatViewSource).toContain('subscribeSubagentProfilesChanged(reloadSubagents)')
    expect(chatViewSource).not.toContain("window.addEventListener('maestrly:subagent-profiles-changed'")
    expect(chatViewSource).toContain('convIdRef.current === conversationId')
    expect(chatViewSource).toContain('agents={subagents}')
  })

  it('global save refreshes locally and notifies only after successful confirmation', () => {
    const saveIdx = settingsSource.indexOf('onSave={')
    const okIdx = settingsSource.indexOf('if (!result.ok) return false', saveIdx)
    const notifyIdx = settingsSource.indexOf('notifySubagentProfilesChanged()', okIdx)
    const refreshIdx = settingsSource.indexOf('void refresh()', okIdx)
    expect(saveIdx).toBeGreaterThan(-1)
    expect(okIdx).toBeGreaterThan(saveIdx)
    expect(notifyIdx).toBeGreaterThan(okIdx)
    expect(refreshIdx).toBeGreaterThan(okIdx)
  })

  it('per-conversation toggle (ChatPlusMenu) notifies only after success without the old callback', () => {
    expect(plusMenuSource).toContain('if (result.ok) notifySubagentProfilesChanged()')
    expect(plusMenuSource).not.toContain('onSubagentsChanged')
  })

  it('per-conversation save/clear notify only after success without the old callback', () => {
    expect(conversationSource).toContain('notifySubagentProfilesChanged()')
    expect(conversationSource).toContain('if (!result.ok) return false')
    expect(conversationSource).not.toContain('onSubagentsChanged')
  })
})
