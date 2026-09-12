import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(path, 'utf8')

describe('subagent session UI contract', () => {
  it('opens every task/delegate through a shared read-only split panel', () => {
    const card = source('src/renderer/components/chat/SubagentCard.tsx')
    const view = source('src/renderer/components/chat/ChatView.tsx')
    const panel = source('src/renderer/components/chat/SubagentSessionPanel.tsx')
    const list = source('src/renderer/components/chat/ChatMessageList.tsx')

    expect(card).toContain("t('subagentSession.open')")
    expect(card).toContain('parentMessageId: messageId')
    // Single-line card: tokens/cost come from the persisted session because the delegate snapshot never receives
    // the final result. Clicking opens the panel; only runs without sessions expand inline.
    expect(card).toContain('subagentRunDisplay(stateMeta, observableSession)')
    expect(card).toContain('onClick={activate}')
    expect(card).toContain('{legacy && legacyOpen && (')
    expect(card).not.toContain("t('subagent.activity')")
    expect(card).not.toContain("t('subagent.profile')")
    expect(view).toContain('<SubagentSessionPanel')
    expect(view).toContain('lg:w-[var(--subagent-pane-width)]')
    expect(view).toContain('beginSubagentPaneResize')
    expect(panel).toContain('<ChatMessageList')
    expect(panel).toContain('readOnly')
    expect(panel).not.toContain('<ChatComposer')
    expect(list).toContain('canEdit={!readOnly && !streaming')
  })

  it('keeps normal activity and Maestro grouping on the same session source', () => {
    const view = source('src/renderer/components/chat/ChatView.tsx')
    const orchestration = source('src/renderer/components/chat/OrchestrationRun.tsx')
    expect(view).toContain('<SubagentActivityPill sessions={subagentSessions}')
    expect(view).toContain('<SubagentSessionsContext.Provider value={subagentSessions}>')
    expect(orchestration).toContain('useSubagentSessions()')
    expect(orchestration).toContain("session?.status === 'preparing'")
  })
})
