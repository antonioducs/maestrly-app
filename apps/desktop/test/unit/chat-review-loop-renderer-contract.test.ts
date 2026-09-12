import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const app = read('../../src/renderer/DesktopApp.tsx')
const chatView = read('../../src/renderer/components/chat/ChatView.tsx')
const picker = read('../../src/renderer/components/chat/ReviewLoopPickerDialog.tsx')
const split = read('../../src/renderer/components/chat/ReviewLoopSplitView.tsx')
const banner = read('../../src/renderer/components/chat/ReviewLoopBanner.tsx')
const lru = read('../../src/renderer/lib/conversation-mount-lru.ts')

describe('paired review renderer contract', () => {
  it('mounts both participant ChatViews and marks both visible in the split', () => {
    expect(app).toContain("splitRole === 'executor'")
    expect(app).toContain("splitRole === 'reviewer'")
    expect(app).toContain('visible={(splitRole !== null || active?.id === c.id) && !mainOverride}')
    expect(app).toContain('data-review-loop-pane={splitRole ?? undefined}')
  })

  it('protects participants from the mount LRU and focuses the Drawer through active conversation', () => {
    expect(lru).toContain('protectedIds?: ReadonlySet<string>')
    expect(app).toContain('protectedIds: protectedReviewIds')
    expect(app).toContain('onFocus={focusReviewPane}')
    expect(app).toContain('handleSelect(conversation)')
  })

  it('keeps terminal split state until explicit dismiss and allows Stop from either pane', () => {
    expect(app).toContain('pairedLoopForActive.loopId !== dismissedSplitLoopId')
    expect(split).toContain('onDismiss()')
    expect(banner).toContain('chatReviewLoopStop(conversationId)')
    expect(chatView).toContain("reviewLoop?.driver === 'maestrly-pair'")
  })

  it('hides the start-review action while either review driver owns the active conversation', () => {
    expect(app).toContain("loop.driver === 'chatgpt-web'")
    expect(app).toContain("loop.status !== 'finished' && loop.status !== 'cancelled' && loop.status !== 'interrupted'")
    expect(app).toContain('!runningReviewLoopForActive &&')
  })

  it('picker configures and creates a fresh sibling reviewer before starting the loop', () => {
    expect(picker).not.toContain('chatReviewLoopCompatible(executor.id)')
    expect(picker).toContain('.chatConfig()')
    expect(picker).toContain('window.api.chatModels(nextProviderId)')
    expect(picker).toContain('<SelectItem key={provider.id} value={provider.id}>')
    expect(picker).toContain('{provider.name}')
    expect(picker).not.toMatch(/`\$\{provider\.name\} · \$\{provider\.accountLabel\}`/)
    expect(picker).toContain('.chatModelMeta(modelId, providerId)')
    expect(picker).toContain('createSiblingConversation({ sourceConversationId: executor.id })')
    expect(picker).toMatch(/`\$\{executor\.name\} · Reviewer`/)
    expect(picker).toContain('chatSetSelection(target.id, { providerId, modelId })')
    expect(picker).toContain('chatSetReasoning(target.id, reasoning)')
    expect(picker).toContain('window.api.chatSetFastMode(')
    expect(picker).toContain('modelMeta?.fastModeCapability === true && fastMode')
    expect(picker.indexOf('createSiblingConversation({ sourceConversationId: executor.id })')).toBeLessThan(
      picker.indexOf('chatReviewLoopStart({')
    )
    expect(picker).toContain('max={10}')
    expect(picker).toContain('severityThreshold: threshold')
  })
})
