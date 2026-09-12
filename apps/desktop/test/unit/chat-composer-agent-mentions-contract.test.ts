import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { shouldReloadOnUserSaved } from '../../src/shared/chat-agent-mentions'

const composerSource = readFileSync(
  new URL('../../src/renderer/components/chat/ChatComposer.tsx', import.meta.url),
  'utf8'
)
const editorCoreSource = readFileSync(
  new URL('../../src/renderer/components/chat/MentionEditor.tsx', import.meta.url),
  'utf8'
)
const mentionsSource = readFileSync(new URL('../../src/shared/chat-agent-mentions.ts', import.meta.url), 'utf8')
const chatViewSource = readFileSync(new URL('../../src/renderer/components/chat/ChatView.tsx', import.meta.url), 'utf8')
const messageListSource = readFileSync(
  new URL('../../src/renderer/components/chat/ChatMessageList.tsx', import.meta.url),
  'utf8'
)
const preloadSource = readFileSync(new URL('../../src/preload/api-chat.ts', import.meta.url), 'utf8')
const editorSource = readFileSync(
  new URL('../../src/renderer/components/chat/subagent-profiles/SubagentProfileRulesEditor.tsx', import.meta.url),
  'utf8'
)

describe('shared contenteditable MentionEditor contract', () => {
  it('serializes live text and structured ranges in one DOM walk', () => {
    // Both change and submit use one shared serialization walk.
    expect(editorCoreSource).toContain('function serializeWithMentions(root: HTMLElement)')
    expect(editorCoreSource).toContain('{ text: string; mentions: StructuredAgentMentionDraft[] }')
    expect(editorCoreSource).toContain('const { text, mentions } = serializeWithMentions(el)')
    // The chip serializes #name and records its exact text range.
    expect(editorCoreSource).toContain("out += '#' + raw")
    expect(editorCoreSource).toContain('const start = out.length')
    expect(editorCoreSource).toContain('mentions.push({ id, name, start, end: out.length })')
    // Text and line breaks increment the offset; file mentions use their serialized token length in DOM order.
    expect(editorCoreSource).toContain("out += '@' + p")
    expect(editorCoreSource).toContain("out += child.textContent ?? ''")
  })

  it('assigns unique mention IDs when chips are selected', () => {
    expect(editorCoreSource).toContain("child.dataset.agentMentionId ?? ''")
    expect(editorCoreSource).toContain('span.dataset.agentMentionId = id')
    // Assign IDs when autocomplete selects chips and preserve them in the DOM.
    expect(editorCoreSource).toContain('makeAgentChip(t, agent, crypto.randomUUID())')
    expect(editorCoreSource).toContain(
      "function makeAgentChip(t: TFunction<'chat'>, agent: SubagentAgentDto, id: string)"
    )
  })

  it('validates occurrence ranges before rebuilding chips', () => {
    expect(editorCoreSource).toMatch(
      /validateStructuredAgentMentions\(\s*structured,\s*text,\s*agents\.map\(\(a\) => a\.name\)\s*\)/
    )
    // Rebuild forbids name-based promotion and textual parsing.
    expect(editorCoreSource).not.toContain('structured.has(m.name)')
    expect(editorCoreSource).not.toContain('findAgentMentions(text)')
    // Create chips only at validated occurrence ranges with their IDs.
    expect(editorCoreSource).toMatch(
      /byIndex\.set\(\s*m\.start,\s*\{ end: m\.end, el: makeAgentChip\(t, agent, m\.id\) \}\s*\)/
    )
  })

  it('reflects live DOM occurrence IDs after mutations', () => {
    expect(editorCoreSource).toContain('onMentionsChange?: (mentions: StructuredAgentMentionDraft[]) => void')
    expect(editorCoreSource).toContain('onMentionsChange?.(mentions)')
    // Catalog rebuild recalculates live DOM metadata for the owner.
    expect(editorCoreSource).toContain('onMentionsChange?.(serializeWithMentions(el).mentions)')
  })

  it('closes autocomplete on Escape without mentions', () => {
    expect(editorCoreSource).toContain("if (e.key === 'Escape')")
    expect(editorCoreSource).toContain('setMention(null)')
  })

  it('rebuilds changed catalogs without corrupting drafts', () => {
    expect(editorCoreSource).toContain('agentsKey')
    expect(editorCoreSource).toContain('lastAgentsRef')
  })

  it('uses effective catalogs and delegates unconsumed keys', () => {
    // Contract: agents accepts null for loading or an array for resolved data.
    expect(editorCoreSource).toContain('agents: SubagentAgentDto[] | null')
    expect(editorCoreSource).toContain('onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => boolean')
    // Enter with no menu open triggers onRequestSubmit; the owner decides whether to submit.
    expect(editorCoreSource).toContain('onRequestSubmit?: () => void')
    expect(editorCoreSource).toContain('onRequestSubmit?.()')
  })

  it('consumes plain Tab and delegates control shortcuts', () => {
    const normalizedEditorSource = editorCoreSource.replace(/\s+/g, ' ')
    const fileMenu = normalizedEditorSource.slice(
      normalizedEditorSource.indexOf('if (menuOpen)'),
      normalizedEditorSource.indexOf('} else if (agentMenuOpen)')
    )
    const agentMenu = normalizedEditorSource.slice(
      normalizedEditorSource.indexOf('} else if (agentMenuOpen)'),
      normalizedEditorSource.indexOf('if (onKeyDown?.(e) === true) return')
    )
    const tabWithoutModifiers = /e\.key === 'Tab' && !e\.shiftKey && !e\.ctrlKey && !e\.metaKey && !e\.altKey/

    expect(fileMenu).toMatch(tabWithoutModifiers)
    expect(agentMenu).toMatch(tabWithoutModifiers)
    expect(normalizedEditorSource.match(new RegExp(tabWithoutModifiers.source, 'g'))).toHaveLength(2)
  })

  it('preserves mention metadata while catalogs are loading', () => {
    // The loading sentinel differs from an empty resolved catalog.
    expect(editorCoreSource).toContain('agents === null ? ' + String.raw`'\0loading'`)
    // Rebuilding while loading renders stubs WITHOUT validateStructuredAgentMentions.
    expect(editorCoreSource).toContain('if (agents === null)')
    expect(editorCoreSource).toContain("source: 'loading'")
    // Only resolved catalogs may publish mention degradation.
    expect(editorCoreSource).toMatch(
      /if \(agents !== null\) \{\s*onMentionsChange\?\.\(serializeWithMentions\(el\)\.mentions\)/
    )
    // The # autocomplete stays closed while loading.
    expect(editorCoreSource).toContain('agents !== null')
  })
})

describe('ChatComposer shared editor ownership contract', () => {
  it('reuses MentionEditor without duplicate DOM mechanics', () => {
    expect(composerSource).toContain("import { MentionEditor, type MentionEditorHandle } from './MentionEditor'")
    expect(composerSource).toContain('<MentionEditor')
    // DOM serialization, chips and menus belong to the shared editor.
    expect(composerSource).not.toContain('function serializeWithMentions')
    expect(composerSource).not.toContain('function makeAgentChip')
    expect(composerSource).not.toContain('function collectAgentMentions')
  })

  it('sends complete live DOM occurrences', () => {
    expect(composerSource).toContain(
      'onSend: (payload: { text: string; agentMentions: StructuredAgentMentionDraft[] }) => void'
    )
    // Submit uses the same core walk as change events and sends full occurrences.
    expect(composerSource).toContain('editorRef.current?.serialize()')
    expect(composerSource).toContain('onSend({ text, agentMentions: mentions })')
  })

  it('routes unconsumed keys to slash palettes and mode shortcuts', () => {
    expect(composerSource).toContain('const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): boolean =>')
    expect(composerSource).toContain(
      "e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && onCycleMode"
    )
    expect(composerSource).toContain(
      "e.key === 'Tab' && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && onCycleReasoning"
    )
    expect(composerSource).toContain('slashOpen')
    expect(composerSource).toContain('return true')
    expect(composerSource).toContain('onKeyDown={handleKeyDown}')
  })

  it('does not promote manual mention text during rebuild', () => {
    // Drafts contain occurrence IDs and ranges rather than deduplicated names.
    expect(composerSource).toContain('structuredAgentMentions?: StructuredAgentMentionDraft[]')
    expect(composerSource).toContain('onMentionsChange?: (mentions: StructuredAgentMentionDraft[]) => void')
  })

  it('rejects numeric and word-prefix mentions', () => {
    expect(mentionsSource).toContain('(?<![\\w#])#([A-Za-z][\\w-]*)')
    expect(mentionsSource).toContain('normalizeSubagentProfileKey')
  })

  it('validateStructuredAgentMentions sanitizes shape BEFORE sorting with a defensive type guard', () => {
    expect(mentionsSource).toContain('function isStructuredAgentMentionDraft(value: unknown)')
    expect(mentionsSource).toContain('Number.isFinite(candidate.start)')
    expect(mentionsSource).toContain('Number.isInteger(candidate.start)')
    expect(mentionsSource).toContain('mentions.filter(isStructuredAgentMentionDraft)')
    // Public signatures accept arbitrary unknown IPC arrays.
    expect(mentionsSource).toContain('mentions: readonly unknown[] | undefined')
  })

  it('loads and forwards effective conversation catalogs', () => {
    expect(chatViewSource).toContain('chatSubagentProfilesCatalog(conversationId)')
    expect(chatViewSource).toContain('agents={subagents}')
    // null means loading; [] means genuinely empty, distinguishing both states.
    expect(chatViewSource).toContain('useState<SubagentAgentDto[] | null>(null)')
    expect(chatViewSource).toContain('setSubagents(null)')
  })

  it('marks virtual and real agents in profile editors', () => {
    expect(editorSource).toContain('agentVirtualBadge')
    expect(editorSource).toContain('agentRealBadge')
    expect(editorSource).toContain('knownAgents={catalog.agents}')
  })
})

describe('structured draft and queue occurrence contract', () => {
  it('stores occurrence IDs and ranges in drafts and queues', () => {
    expect(chatViewSource).toContain(
      'const [draftMentions, setDraftMentions] = useState<StructuredAgentMentionDraft[]>([])'
    )
    expect(chatViewSource).toContain('agentMentions: StructuredAgentMentionDraft[]')
  })

  it('restores queued text and complete occurrences', () => {
    expect(chatViewSource).toContain('setDraft(q.text)')
    expect(chatViewSource).toContain('setDraftMentions(q.agentMentions)')
  })

  it('clears occurrences with drafts across submission and reset paths', () => {
    expect(chatViewSource).toContain("setDraft('')")
    expect(chatViewSource).toContain('setDraftMentions([])')
    const clears = chatViewSource.split('setDraftMentions([])').length - 1
    expect(clears).toBeGreaterThanOrEqual(3)
  })

  it('sends complete occurrences without renderer name reduction', () => {
    // IPC carries IDs and offsets; main performs validated reduction.
    // Loading catalogs yield empty optimistic parts, but main always revalidates.
    expect(chatViewSource).toContain('const catalogNames = (subagents ?? []).map((a) => a.name)')
    expect(chatViewSource).toContain('validateStructuredAgentMentions(agentMentions, mentionText, catalogNames)')
    expect(chatViewSource).toContain(
      "parts.push({ type: 'agent-mention', id: m.id, name: m.name, start: m.start, end: m.end })"
    )
    expect(chatViewSource).toMatch(/window\.api\s*\.chatSend\(/)
    expect(chatViewSource).not.toContain('dedupeAgentMentionNames')
  })

  it('sets reconciliation flags from raw mention payloads', () => {
    expect(chatViewSource).toContain('const agentMentionsSentRef = useRef(false)')
    // Use raw payloads rather than locally validated optimistic parts.
    expect(chatViewSource).toContain('agentMentionsSentRef.current = agentMentions.length > 0')
    const doSendStart = chatViewSource.indexOf('const doSend = useCallback')
    const doSendEnd = chatViewSource.indexOf('const finishTurn = useCallback', doSendStart)
    const doSendSrc = chatViewSource.slice(doSendStart, doSendEnd)
    // Set flags before chatSend and optimistic message creation.
    expect(doSendSrc.indexOf('agentMentionsSentRef.current = agentMentions.length > 0')).toBeLessThan(
      doSendSrc.indexOf('.chatSend(')
    )
    // chatSend still receives complete occurrences.
    expect(doSendSrc).toContain('agentMentions')
    expect(doSendSrc).toMatch(/window\.api\s*\.chatSend\(/)
  })

  it('reconciles saved mentions through shouldReloadOnUserSaved', () => {
    expect(chatViewSource).toContain('const localAgentMentions = agentMentionsSentRef.current')
    expect(chatViewSource).toContain('agentMentionsSentRef.current = false')
    expect(chatViewSource).toContain('localAgentMentions')
    expect(chatViewSource).toContain('shouldReloadOnUserSaved({')
    expect(chatViewSource).toContain('void reloadLatestPage()')
    // Reconciliation covers slash commands, interpreted images and structured mentions.
  })

  it('clears reconciliation flags on failures and conversation changes', () => {
    // chatSend failure clears both flags (any !res.ok, including empty).
    const failIdx = chatViewSource.indexOf('if (!res.ok)')
    expect(failIdx).toBeGreaterThan(-1)
    const failPath = chatViewSource.slice(
      failIdx,
      chatViewSource.indexOf('[conversationId, pushAssistantError, reloadLatestPage, subagents]')
    )
    expect(failPath).toContain('slashSentRef.current = false')
    expect(failPath).toContain('agentMentionsSentRef.current = false')
    // The reset effect exists alongside the refs for conversationId changes.
    const resetBlock = chatViewSource.slice(
      chatViewSource.indexOf('const agentMentionsSentRef = useRef(false)'),
      chatViewSource.indexOf('const doSend = useCallback')
    )
    expect(resetBlock).toContain('slashSentRef.current = false')
    expect(resetBlock).toContain('agentMentionsSentRef.current = false')
    expect(resetBlock).toContain('[conversationId]')
  })

  it('submitEdit rebuilds the optimistic message with text, files, and locally validated agent mentions', () => {
    expect(chatViewSource).toContain(
      'async (id: string, payload: { text: string; agentMentions: StructuredAgentMentionDraft[] })'
    )
    expect(chatViewSource).toContain('window.api.chatResend(conversationId, id, text, agentMentions)')
    // Preserves attachments and agent-mention parts with ranges in the optimistic bubble.
    expect(chatViewSource).toContain(
      "(p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file' && !p.hidden"
    )
    expect(chatViewSource).toContain("resendHasImage = files.some((p) => p.kind === 'image')")
    expect(chatViewSource).toContain(
      "parts.push({ type: 'agent-mention', id: m.id, name: m.name, start: m.start, end: m.end })"
    )
  })

  it('uses identical reconciliation flags for edits and sends', () => {
    const editStart = chatViewSource.indexOf('const submitEdit = useCallback')
    const editEnd = chatViewSource.indexOf('const contextRatio = useMemo')
    expect(editStart).toBeGreaterThan(-1)
    expect(editEnd).toBeGreaterThan(editStart)
    const editSrc = chatViewSource.slice(editStart, editEnd)
    // Edits use raw payloads like sends without depending on local validation.
    expect(editSrc).toContain('const invocation = parseSlashInvocation(text)')
    expect(editSrc).toContain('slashSentRef.current = invocation != null')
    expect(editSrc).toContain('agentMentionsSentRef.current = agentMentions.length > 0')
    // Flags armed BEFORE chatResend.
    expect(editSrc.indexOf('agentMentionsSentRef.current = agentMentions.length > 0')).toBeLessThan(
      editSrc.indexOf('window.api.chatResend(')
    )
    expect(editSrc.indexOf('slashSentRef.current = invocation != null')).toBeLessThan(
      editSrc.indexOf('window.api.chatResend(')
    )
  })

  it('clears edit flags on all failed responses', () => {
    const editStart = chatViewSource.indexOf('const submitEdit = useCallback')
    const editEnd = chatViewSource.indexOf('const contextRatio = useMemo')
    expect(editStart).toBeGreaterThan(-1)
    expect(editEnd).toBeGreaterThan(editStart)
    const editSrc = chatViewSource.slice(editStart, editEnd)
    const failIdx = editSrc.indexOf('if (!res.ok)')
    expect(failIdx).toBeGreaterThan(-1)
    const failPath = editSrc.slice(failIdx)
    expect(failPath).toContain('slashSentRef.current = false')
    expect(failPath).toContain('agentMentionsSentRef.current = false')
    expect(failPath).toContain("if (res.error !== 'empty')")
    // Empty failures must clear flags rather than leaving them orphaned.
    expect(editSrc).not.toContain("if (!res.ok && res.error !== 'empty')")
  })

  it('validates trimmed content while sending raw draft text', () => {
    expect(chatViewSource).not.toContain('const t = rawText.trim()')
    expect(chatViewSource).toContain('const text = rawText')
    expect(chatViewSource).toContain('if (!text.trim() && attachments.length === 0) return')
    expect(chatViewSource).toContain('text, attachments: atts, agentMentions }')
    expect(chatViewSource).toContain('void doSend(text, atts, agentMentions)')
    const sendPath = chatViewSource.slice(
      chatViewSource.indexOf('const submitDraft'),
      chatViewSource.indexOf('const searchFiles')
    )
    expect(sendPath).not.toContain('rawText.trim()')
    const trimCount = (sendPath.match(/\.trim\(/g) ?? []).length
    expect(trimCount).toBe(1)
  })

  it('does not trim or prefix sent and restored queue text', () => {
    const doSendStart = chatViewSource.indexOf('const doSend = useCallback')
    const doSendEnd = chatViewSource.indexOf('const finishTurn = useCallback', doSendStart)
    const doSendSrc = chatViewSource.slice(doSendStart, doSendEnd)
    expect(doSendSrc).not.toContain('.trim(')
    expect(doSendSrc).not.toContain('.trimStart(')
    expect(chatViewSource).toContain('setDraft(q.text)')
    expect(chatViewSource).toContain('setDraftMentions(q.agentMentions)')
  })
})

describe('inline edit-and-resend editor contract', () => {
  it('uses shared MentionEditor for inline edits', () => {
    expect(messageListSource).toContain("import { MentionEditor, type MentionEditorHandle } from './MentionEditor'")
    expect(messageListSource).toContain('<MentionEditor')
    expect(messageListSource).not.toContain('<textarea')
  })

  it('submits inline text and structured mentions together', () => {
    expect(messageListSource).toContain('mentions: StructuredAgentMentionDraft[]')
    expect(messageListSource).toContain('agents: SubagentAgentDto[] | null')
    expect(messageListSource).toContain('onSubmit(id, { text: serialized, agentMentions: liveMentions })')
    // Submit reads live DOM without trimming occurrence offsets.
    expect(messageListSource).toContain('editorRef.current?.serialize()')
  })

  it('legacy parts without ranges degrade to plain text and never guess by name', () => {
    expect(messageListSource).toContain("typeof p.start === 'number' && typeof p.end === 'number'")
    expect(messageListSource).toContain('editMentions')
  })

  it('forwards conversation catalogs through message lists', () => {
    expect(messageListSource).toContain('agents?: SubagentAgentDto[] | null')
    expect(chatViewSource).toContain('agents={subagents}')
  })

  it('blocks mention edits while catalogs load', () => {
    expect(messageListSource).toContain('hasAgentMentions')
    expect(messageListSource).toContain('editBlockedByCatalog')
    expect(messageListSource).toContain('catalogLoading')
    // Never convert loading null catalogs to empty arrays before editing.
    expect(messageListSource).toContain('agents={agents ?? null}')
    expect(messageListSource).not.toContain('agents={agents ?? []}')
  })

  it('preserves loading metadata and degrades only after catalog resolution', () => {
    // Loading paths preserve metadata without emitting mention changes.
    expect(editorCoreSource).toContain('agents === null ? ' + String.raw`'\0loading'`)
    expect(editorCoreSource).toContain("source: 'loading'")
    // After resolution, validation degrades removed catalog agents.
    expect(editorCoreSource).toMatch(
      /validateStructuredAgentMentions\(\s*structured,\s*text,\s*agents\.map\(\(a\) => a\.name\)\s*\)/
    )
    // ChatView conversation switching sets null BEFORE fetching; convIdRef discards late responses.
    expect(chatViewSource).toContain('setSubagents(null)')
    expect(chatViewSource).toContain('if (convIdRef.current === conversationId) setSubagents(catalog.agents)')
  })
})

describe('preload structured send and resend contract', () => {
  it('chatSend and chatResend transport StructuredAgentMentionDraft arrays', () => {
    expect(preloadSource).toContain("import type { StructuredAgentMentionDraft } from '../shared/chat-agent-mentions'")
    expect(preloadSource).toContain('agentMentions?: StructuredAgentMentionDraft[]')
    expect(preloadSource).toContain(
      "ipcRenderer.invoke('chat:send', { conversationId, text, attachments, agentMentions })"
    )
    expect(preloadSource).toContain(
      "ipcRenderer.invoke('chat:resend', { conversationId, fromMessageId, text, agentMentions })"
    )
  })
})

describe('pure user-saved reload decisions', () => {
  const base = {
    streaming: true,
    compacted: undefined as boolean | undefined,
    imagesDescribed: 0,
    localSlash: false,
    localAgentMentions: false,
    localImages: false,
  }

  it('streaming plus ordinary send without mentions does NOT reload', () => {
    expect(shouldReloadOnUserSaved(base)).toBe(false)
  })

  it('streaming plus a structured mention reloads', () => {
    expect(shouldReloadOnUserSaved({ ...base, localAgentMentions: true })).toBe(true)
  })

  it('streaming plus a slash command reloads', () => {
    expect(shouldReloadOnUserSaved({ ...base, localSlash: true })).toBe(true)
  })

  it('compacted or imagesDescribed reloads', () => {
    expect(shouldReloadOnUserSaved({ ...base, compacted: true })).toBe(true)
    expect(shouldReloadOnUserSaved({ ...base, imagesDescribed: 2 })).toBe(true)
  })

  it('outside streaming reloads changes made by background turns', () => {
    expect(shouldReloadOnUserSaved({ ...base, streaming: false })).toBe(true)
  })

  it('applies send reconciliation combinations to resend', () => {
    // Resend during catalog loading still triggers mention reconciliation.
    expect(shouldReloadOnUserSaved({ ...base, streaming: true, localAgentMentions: true, localSlash: false })).toBe(
      true
    )
    // Resending /skill args sets localSlash=true and reloads.
    expect(shouldReloadOnUserSaved({ ...base, streaming: true, localSlash: true, localAgentMentions: false })).toBe(
      true
    )
    // Ordinary resend without slash or mentions during streaming does NOT trigger an extra reload.
    expect(shouldReloadOnUserSaved({ ...base, streaming: true, localSlash: false, localAgentMentions: false })).toBe(
      false
    )
  })

  it('ChatView imports and uses shared shouldReloadOnUserSaved', () => {
    expect(chatViewSource).toContain('shouldReloadOnUserSaved')
    expect(chatViewSource).toContain("from '../../../shared/chat-agent-mentions'")
    expect(mentionsSource).toContain('export function shouldReloadOnUserSaved')
  })
})
