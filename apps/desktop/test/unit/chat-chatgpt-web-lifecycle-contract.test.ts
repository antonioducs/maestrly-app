import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const service = readFileSync(fileURLToPath(new URL('../../src/main/chat/service.ts', import.meta.url)), 'utf8')
const manager = readFileSync(
  fileURLToPath(new URL('../../src/main/chat/chatgpt-web/manager.ts', import.meta.url)),
  'utf8'
)
const tunnelRuntime = readFileSync(
  fileURLToPath(new URL('../../src/main/chat/chatgpt-web/tunnel-runtime.ts', import.meta.url)),
  'utf8'
)
const index = readFileSync(fileURLToPath(new URL('../../src/main/index.ts', import.meta.url)), 'utf8')
const drawer = readFileSync(fileURLToPath(new URL('../../src/renderer/components/Drawer.tsx', import.meta.url)), 'utf8')
const plusMenu = readFileSync(
  fileURLToPath(new URL('../../src/renderer/components/chat/ChatPlusMenu.tsx', import.meta.url)),
  'utf8'
)
const accessEditor = readFileSync(
  fileURLToPath(new URL('../../src/renderer/components/chat/ChatGptWebAccessEditor.tsx', import.meta.url)),
  'utf8'
)
const chatView = readFileSync(
  fileURLToPath(new URL('../../src/renderer/components/chat/ChatView.tsx', import.meta.url)),
  'utf8'
)
const sessionBanner = readFileSync(
  fileURLToPath(new URL('../../src/renderer/components/chat/ChatGptWebSessionBanner.tsx', import.meta.url)),
  'utf8'
)
const shortcuts = readFileSync(
  fileURLToPath(new URL('../../src/renderer/components/settings/ShortcutsSection.tsx', import.meta.url)),
  'utf8'
)

function serviceSegment(from: string, until: string): string {
  const start = service.indexOf(from)
  const end = service.indexOf(until, start + from.length)
  return start >= 0 && end > start ? service.slice(start, end) : ''
}

describe('ChatGPT Web companion lifecycle contract', () => {
  it('revokes tokens before closing bridges and windows', () => {
    const endSession = manager.match(/export async function endSession\([\s\S]*?\n}\n/)?.[0]
    expect(endSession).toBeTruthy()
    expect(endSession!.indexOf('getRouter().unregister(session.sessionKey)')).toBeLessThan(
      endSession!.indexOf('session.end()')
    )
    expect(endSession!.indexOf('session.end()')).toBeLessThan(
      endSession!.lastIndexOf('companionWindows.close(conversationId)')
    )
    expect(endSession!.lastIndexOf('releaseCompanionPlacement(conversationId)')).toBeGreaterThan(
      endSession!.indexOf('session.end()')
    )
  })

  it('arms sessions and returns pairing prompts without starting views', () => {
    const handler = serviceSegment("'chat:chatgpt-web:companion-start'", "'chat:chatgpt-web:companion-end'")
    expect(handler).toBeTruthy()
    expect(handler).toContain('chatGptWeb.startSession')
    expect(handler).toContain('chatGptWeb.companionPrompt(conversationId)')
    expect(handler).toContain(
      'pairingRequired: chatGptWeb.sessionForConversation(conversationId)?.info().pairingRequired'
    )
    expect(handler).not.toMatch(/automation|kickoff\(|next_input/)
  })

  it('copies only active keys without exposing global status secrets', () => {
    expect(manager).toContain('export function companionSessionKey(conversationId: string)')
    expect(manager).toContain('sessionForConversation(conversationId)?.sessionKey ?? null')
    expect(service).toContain("'chat:chatgpt-web:companion-session-key'")
    expect(sessionBanner).toContain('chatGptWebCompanionCopySessionKey(conversationId)')
    expect(sessionBanner).toContain("t('chatgptWeb.copySessionKey')")
  })

  it('hides entries when the global feature is disabled and offers start in the fallback', () => {
    expect(drawer).toContain('chatGptWebEnabled')
    expect(drawer).toContain("t('drawer.chatgptStart')")
    expect(drawer).toContain('startChatGptWebCompanion(convId)')
    expect(drawer).toContain("t('drawer.chatgptPairingInstruction'")
    expect(drawer).toContain('chatGptWebCompanionCopyPrompt(convId)')
    expect(drawer).not.toContain('navigator.clipboard')
    expect(plusMenu).toContain('chatGptWebEnabled && (')
    expect(shortcuts).toContain("tab !== 'chatgpt'")
  })

  it('offers companion controls in every standard chat', () => {
    expect(chatView).toContain('<ChatPlusMenu')
    expect(plusMenu).toContain('chatGptWebEnabled && (')
    expect(plusMenu).not.toContain('allowChatGptWebCompanion')
  })

  it('opens sessionless fallback shortcuts only when globally enabled', () => {
    expect(index).toContain("safeWindowSend(mainWindow, 'chat:chatgpt-web:open', convId)")
    expect(index).toContain('if (!isChatGptWebEnabled()) return')
    expect(index).toContain('if (!hasActiveChatGptWebSession(convId))')
    expect(index).toContain('openChatGptWebFallback(convId)')
  })

  it('opens windows only through explicit companion channels', () => {
    const openHandler = service.match(/deps\.mhandle\('chat:chatgpt-web:companion-open'[\s\S]*?\n\s*}\)/)?.[0]
    expect(openHandler).toBeTruthy()
    expect(openHandler).toContain('chatGptWeb.openCompanionWindow(conversationId)')

    const startHandler = serviceSegment("'chat:chatgpt-web:companion-start'", "'chat:chatgpt-web:companion-end'")
    expect(startHandler).not.toContain('openCompanionWindow')
  })

  it('restores discarded renderers through manager session gates', () => {
    const restore = manager.match(/export async function restoreCompanionWindow\([\s\S]*?\n}\n/)?.[0]
    expect(restore).toBeTruthy()
    expect(restore).toContain('materializeCompanionWindow(conversationId)')
    expect(index).toContain('restoreCompanionWindow as restoreChatGptWebCompanionWindow')
    expect(index).toContain('restoreChatGptView: async (convId)')
    expect(index.match(/const restoration = restoreChatGptWebCompanionWindow\(convId\)/g)).toHaveLength(2)
    expect(index).toContain("popupManager.closePopup(convId, 'chatgpt')")
    expect(index).toContain("floatingManager.reattach(convId, 'chatgpt')")
    expect(index.match(/if \(!result\.ok\) cleanupFailedChatGptShortcutRestore\(convId\)/g)).toHaveLength(2)
  })

  it('keeps integration-specific runners and automation out of composers', () => {
    expect(service).not.toMatch(/runChatGptWebChat|ChatGptWebAutomation|CHATGPT_WEB_MODEL|automation-retry/)
  })

  it('arms sessions without views until explicitly opened', () => {
    const start = manager.match(/export async function startSession\([\s\S]*?\n}\n/)?.[0]
    expect(start).toBeTruthy()
    expect(start!.match(/startIsCurrent\(/g)?.length).toBeGreaterThanOrEqual(4)
    expect(start).toContain('releaseSessionStart(lease)')
    expect(start).toContain('rollbackSession')
    expect(start).not.toContain('companionWindows.open')
    expect(start).not.toContain('openCompanionWindow')
    expect(manager).toContain('await companionWindows.open(conversationId)')
  })

  it('rearms conversations with stable tunnel-scoped keys', () => {
    expect(manager).toContain(
      'deriveResumableSessionKey({ platformKey, tunnelId, conversationId, sessionScope, capabilityFingerprint })'
    )
    const start = manager.match(/export async function startSession\([\s\S]*?\n}\n/)?.[0]
    expect(start).toContain(
      'const sessionKey = sessionKeyForConversation(input.conversationId, capabilityInfo.fingerprint)'
    )
    expect(manager).toContain('chatGptWebSessionScope: undefined')
    expect(manager).toContain('companionNeedsPairing(input.conversationId)')
    expect(manager).toContain('resumableChatGptConversationUrl(prefs.chatGptWebUrl)')
    expect(manager).toContain('onPaired: (fingerprint) =>')
    expect(manager).toContain(
      'patchConvUiPrefs(input.conversationId, { chatGptWebPairedCapabilityFingerprint: fingerprint })'
    )
  })

  it('preserves conversation-scoped plan reviews across rearm', () => {
    expect(manager).toContain('const planReviewControllers = new Map<string, PlanReviewController>()')
    expect(manager).toContain('const planReviewController = planReviewControllerFor(input.conversationId)')
    expect(manager).toContain('planReview: planReviewController')
    expect(manager).toContain('planReviewControllers.get(conversationId)')
    expect(manager).toContain('controller?.resolve(reviewId, outcome)')

    const endSession = manager.match(/export async function endSession\([\s\S]*?\n}\n/)?.[0]
    expect(endSession).toBeTruthy()
    expect(endSession).not.toContain('discardPlanReviews')
    expect(endSession).not.toContain('planReviewControllers.delete')
    expect(manager).toContain('export function discardPlanReviews(conversationId: string)')
    expect(manager).toContain('for (const controller of planReviewControllers.values()) controller.dispose()')
  })

  it('isolates Web and Maestrly review cleanup', () => {
    expect(manager).toContain("createPlanReviewController(() => releasePlanRevision(conversationId, 'chatgpt-web'))")
    expect(manager).toContain("releasePlanRevision(input.conversationId, 'chatgpt-web')")
    expect(service).toContain("releasePlanRevision(conversationId, 'maestrly-chat')")
  })

  it('has main-process barriers for reset and final shutdown', () => {
    expect(manager).toContain('transportConfigurationMutationPending()')
    expect(manager).toContain(
      'if (sessions.size > 0 || sessionStarts.size > 0 || probeTimer || transportConfigurationMutationPending())'
    )
    expect(manager).toContain('let shuttingDown = false')
    expect(manager).toContain('shuttingDown = true')
    expect(manager).toContain('await waitForSessionStarts()')
    expect(manager).toContain('await transportStopping')
  })

  it('serializes tunnel creation and configuration behind one async barrier', () => {
    const create = serviceSegment("'chat:chatgpt-web:create-tunnel'", "'chat:chatgpt-web:companion-start'")
    const configure = serviceSegment("'chat:chatgpt-web:configure'", "'chat:chatgpt-web:principals'")
    expect(create).toContain('withTransportConfigurationMutation')
    expect(create).toContain('transportConfigurationHasActiveResources')
    expect(create).toContain('setTunnelId(result.data.id)')
    expect(configure).toContain('withTransportConfigurationMutation')
  })

  it('treats companions as managed providers in generic writes', () => {
    const update = serviceSegment("'chat:provider-update'", "'chat:provider-remove'")
    const keySet = serviceSegment("'chat:key-set'", "'chat:key-clear'")
    const keyClear = serviceSegment("'chat:key-clear'", "'chat:set-default'")
    expect(update).toContain('isManagedProvider(id)')
    expect(keySet).toContain('isManagedProvider(providerId)')
    expect(keyClear).toContain('isManagedProvider(providerId)')
  })

  it('distinguishes signal exits and avoids retries during initial start', () => {
    expect(tunnelRuntime).toContain('attempt.proc.signalCode !== null')
    expect(tunnelRuntime).toContain('let startInProgress = false')
    expect(tunnelRuntime).toContain('if (startInProgress)')
  })

  it('exposes curated browser modes without generic automation APIs', () => {
    expect(plusMenu).toContain('<ChatGptWebAccessEditor')
    expect(accessEditor).toContain("value: 'off'")
    expect(accessEditor).toContain("value: 'inspect'")
    expect(accessEditor).toContain("value: 'interact'")
    expect(accessEditor).toContain('const controlsDisabled = disabled || !editable')
    expect(accessEditor).toContain("t('chatGptWebAccess.browserIsolation')")
    expect(accessEditor).toContain('hasEffectiveChatGptWebMcpWriteAccess(info, capabilities)')
    expect(drawer).toContain('<ChatGptWebAccessEditor')
    expect(drawer).toContain("t('drawer.chatgptStartWithBrowser'")
    expect(drawer).toContain("t('drawer.chatgptRestartToApply')")
    expect(drawer).toContain('chatGptReviewLoopActive')
    expect(drawer).toContain("'top-[120px]' : 'top-11'")
    expect(sessionBanner).toContain("reviewLoop.reviewScope === 'frontend'")
    expect(sessionBanner).toContain("t('chatgptWeb.browserAccessBadge'")
    expect(sessionBanner).toContain('chatGptWebReviewLoopShowPreview(conversationId)')
    expect(sessionBanner).toContain("'chatgptWeb.reviewLoopOpenPreview'")
    expect(sessionBanner).toContain("'chatgptWeb.reviewLoopFocusTab'")
    expect(sessionBanner).toContain("'chatgptWeb.reviewLoopVisualAttached'")
    expect(service).toContain("'chat:chatgpt-web:review-loop:show-preview'")
    expect(service).not.toContain('chat:chatgpt-web:review-loop:browser-command')
  })

  it('saves drafts before start and preserves live capabilities in place', () => {
    const drawerSave = drawer.indexOf('chatGptWebSetCapabilities(convId, chatGptCapabilities.capabilities)')
    const drawerStart = drawer.indexOf('startChatGptWebCompanion(convId)', drawerSave)
    expect(drawerSave).toBeGreaterThanOrEqual(0)
    expect(drawerStart).toBeGreaterThan(drawerSave)
    expect(manager).toContain("if (sessionForConversation(conversationId)) throw new Error('companion-session-active')")
    expect(manager).toContain('const capabilityInfo = chatGptWebCapabilitiesInfo(')
    expect(manager).toContain('browserCapability: capabilityInfo.capabilities.browser')
    expect(accessEditor).toContain("t('chatGptWebAccess.conversationTitle')")
    expect(accessEditor).toContain("(['off', 'read'] as const)")
    expect(service).toContain("value.conversation !== 'off' && value.conversation !== 'read'")
    expect(manager).toContain("capabilityInfo.capabilities.conversation === 'read'")
    expect(manager).toContain('conversation: capabilityInfo.capabilities.conversation')
  })

  it('holds UI reservations during terminal teardown without Stop', () => {
    expect(chatView).toContain('chatReviewLoopStatus(conversationId).then(setReviewLoop)')
    expect(chatView).toContain('isReviewLoopConversationReserved(reviewLoop.status)')
    expect(sessionBanner).toContain("finished: 'reviewLoopFinishing'")
    expect(sessionBanner).toContain("cancelled: 'reviewLoopStopping'")
    expect(sessionBanner).toContain("reviewLoop?.status === 'finished'")
    expect(sessionBanner).toContain("reviewLoop?.status === 'cancelled'")
    expect(sessionBanner).toContain('{loopActive && !loopStopping && (')
  })
})
