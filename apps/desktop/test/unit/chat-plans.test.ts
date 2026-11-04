import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import {
  clearChatMessages,
  deleteChatMessagesFrom,
  getMessageSeq,
  upsertChatMessage,
} from '../../src/main/chat/chat-store'
import { renderTranscript } from '../../src/main/chat/message'
import {
  type PlanEntry,
  PLAN_INLINE_MAX_TOKENS,
  planOutline,
  planRef,
  summaryWithPlans,
  summaryWithoutPlans,
} from '../../src/main/chat/plans/context'
import {
  getConversationPlan,
  listConversationPlans,
  recordApprovedPlan,
  recordPlanDecision,
  recordStagedPlan,
  resetPlanReconciliation,
} from '../../src/main/chat/plans/store'
import { registerHistoryTools } from '../../src/main/mcp/tools/history'
import type { McpToolContext } from '../../src/main/mcp/tools/context'
import type { MessagePart } from '../../src/shared/chat'

const entry = (overrides: Partial<PlanEntry> = {}): PlanEntry => ({
  id: randomUUID(),
  version: 1,
  title: 'Checkout',
  content: '## Plan\n- Step one\n- Step two',
  status: 'approved',
  createdAt: Date.UTC(2026, 10, 4),
  ...overrides,
})

describe('plans section of a summary', () => {
  it('carries a short approved plan verbatim after the index', () => {
    const older = entry({ status: 'discarded', title: 'Old idea', createdAt: Date.UTC(2026, 10, 3) })
    const active = entry()
    const summary = summaryWithPlans('## Objective\nShip it', [older, active])
    expect(summary.startsWith('## Objective\nShip it\n\n<conversation_plans>')).toBe(true)
    expect(summary).toContain(`- ${planRef(older.id)} · v1 · discarded · Old idea · 2026-11-03`)
    expect(summary).toContain(`- ${planRef(active.id)} · v1 · approved (being implemented) · Checkout · 2026-11-04`)
    expect(summary).toContain(
      `<approved_plan id="${planRef(active.id)}">\n## Plan\n- Step one\n- Step two\n</approved_plan>`
    )
  })

  it('carries only the outline of a long approved plan and points to plan_read', () => {
    const detail = 'Detail line that the outline leaves out. '.repeat(400)
    const active = entry({
      content: `# Big plan\n${detail}\n## Phase 1\n- Do A\n  - nested detail\n## Phase 2\n- Do B`,
    })
    const summary = summaryWithPlans('S', [active])
    expect(summary).toContain('plan_read')
    expect(summary).toContain(`<approved_plan_outline id="${planRef(active.id)}">`)
    expect(summary).toContain('## Phase 1\n- Do A\n## Phase 2\n- Do B')
    expect(summary).not.toContain('Detail line')
    expect(summary).not.toContain('nested detail')
    expect(Buffer.byteLength(summary) / 3).toBeLessThan(PLAN_INLINE_MAX_TOKENS)
  })

  it('lists plans without a body when the approval is still verbatim, or when a newer plan awaits review', () => {
    const approved = entry()
    expect(summaryWithPlans('S', [approved], { activeInContext: true })).not.toContain('<approved_plan')
    const proposed = entry({ status: 'proposed', title: 'Next' })
    const pending = summaryWithPlans('S', [approved, proposed])
    expect(pending).not.toContain('<approved_plan')
    expect(pending).not.toContain('being implemented')
    expect(pending).toContain('proposed · Next')
  })

  it('replaces an older section and the verbatim plan older summaries carried, and adds nothing without plans', () => {
    const legacy =
      'Summary text\n\nThe plan the user approved, kept verbatim across compaction. Keep following it exactly:\n' +
      '<approved_plan>\nOLD\n</approved_plan>'
    const once = summaryWithPlans(legacy, [entry()])
    expect(once).not.toContain('OLD')
    const twice = summaryWithPlans(`${once}\n\nMore`, [entry({ content: '- NEW' })])
    expect(twice.match(/<conversation_plans>/g)).toHaveLength(1)
    expect(twice).toContain('- NEW')
    expect(summaryWithPlans(legacy, [])).toBe('Summary text')
    expect(summaryWithoutPlans(twice)).toBe('Summary text\n\nMore')
  })

  it('keeps the outline to headings and top-level items', () => {
    expect(planOutline('# T\ntext\n1. First\n   deep\n* Second\n    - deeper')).toBe('# T\n1. First\n* Second')
  })

  it('never shows the plans section to the summarizer', () => {
    const summary = summaryWithPlans('PREVIOUS', [entry({ content: '- SECRET_STEP' })])
    const transcript = renderTranscript([
      {
        id: 'a',
        conversationId: 'c',
        role: 'assistant',
        createdAt: 1,
        parts: [{ type: 'compaction', id: 'm', text: summary, strategy: 'summary' }],
      },
      { id: 'u', conversationId: 'c', role: 'user', createdAt: 2, parts: [{ type: 'text', id: 't', text: 'go' }] },
    ])
    expect(transcript).toContain('Previous summary:\nPREVIOUS')
    expect(transcript).not.toContain('SECRET_STEP')
  })
})

describe('plan store', () => {
  beforeEach(() => {
    freshDb()
    resetPlanReconciliation()
  })
  afterEach(closeDb)

  const conversation = () => makeConversation(makeWorkspace().id).id
  let clock = 1_000
  const say = (conversationId: string, role: 'user' | 'assistant', parts: MessagePart[]): string => {
    const id = randomUUID()
    upsertChatMessage({ id, conversationId, role, createdAt: ++clock, parts })
    return id
  }
  const reviewPlan = (plan: string, title?: string): MessagePart => ({
    type: 'tool',
    id: randomUUID(),
    toolCallId: randomUUID(),
    toolName: 'mcp__maestrly__review_plan',
    input: { plan, ...(title ? { title } : {}) },
    state: { status: 'completed', output: 'Plan submitted' },
  })
  const approval = (plan: string): MessagePart => ({
    type: 'text',
    id: randomUUID(),
    text: `Implement the FINAL approved plan.\n\n<approved_plan>\n${plan}\n</approved_plan>`,
  })

  it('records proposals and decisions, storing the edited text of an approval', () => {
    const id = conversation()
    recordStagedPlan(id, { version: 1, title: 'First', content: '- one' }, 1)
    recordStagedPlan(id, { version: 2, title: 'First', content: '- one, revised' }, 2)
    recordPlanDecision(id, { action: 'approve', content: '- one, edited' }, 3)
    expect(listConversationPlans(id).map(({ version, status, content }) => ({ version, status, content }))).toEqual([
      { version: 1, status: 'superseded', content: '- one' },
      { version: 2, status: 'approved', content: '- one, edited' },
    ])
    recordStagedPlan(id, { version: 1, content: '## Second\n- two' }, 4)
    recordPlanDecision(id, { action: 'discard', content: '## Second\n- two' }, 5)
    const plans = listConversationPlans(id)
    expect(plans.at(-1)).toMatchObject({ status: 'discarded', title: 'Second' })
  })

  it('records a plan handed to another conversation once', () => {
    const id = conversation()
    recordApprovedPlan(id, '- handed over', 'Handoff', 1)
    recordApprovedPlan(id, '- handed over', 'Handoff', 2)
    expect(listConversationPlans(id)).toEqual([expect.objectContaining({ status: 'approved', title: 'Handoff' })])
  })

  it('rebuilds the plans of a conversation from its transcript', () => {
    const id = conversation()
    say(id, 'assistant', [reviewPlan('<proposed_plan>\n- first\n</proposed_plan>', 'First')])
    say(id, 'assistant', [reviewPlan('- second', 'Second')])
    say(id, 'user', [approval('- second')])
    say(id, 'assistant', [reviewPlan('- third')])
    expect(listConversationPlans(id).map(({ title, status, content }) => ({ title, status, content }))).toEqual([
      { title: 'First', status: 'superseded', content: '- first' },
      { title: 'Second', status: 'approved', content: '- second' },
      { title: '- third', status: 'proposed', content: '- third' },
    ])
    // Already recorded plans are not added twice.
    resetPlanReconciliation()
    expect(listConversationPlans(id)).toHaveLength(3)
  })

  it('forgets the plans of deleted or cleared messages', async () => {
    const id = conversation()
    say(id, 'assistant', [reviewPlan('- kept')])
    say(id, 'user', [approval('- kept')])
    const removed = say(id, 'assistant', [reviewPlan('- removed')])
    expect(listConversationPlans(id)).toHaveLength(2)
    deleteChatMessagesFrom(id, getMessageSeq(removed)!)
    expect(listConversationPlans(id).map((plan) => plan.content)).toEqual(['- kept'])
    await clearChatMessages(id)
    expect(listConversationPlans(id)).toEqual([])
  })

  it('reads a plan by reference, the latest by default, and lists the ids it knows otherwise', async () => {
    const id = conversation()
    recordStagedPlan(id, { version: 1, title: 'Only', content: '## Only\n- step' }, 1)
    const [plan] = listConversationPlans(id)
    expect(getConversationPlan(id)?.id).toBe(plan.id)
    expect(getConversationPlan(id, planRef(plan.id))?.id).toBe(plan.id)

    const handlers = new Map<
      string,
      (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    >()
    registerHistoryTools({
      convId: id,
      locale: 'en',
      t: (key: string, values?: Record<string, string>) => (values?.ids ? `${key}: ${values.ids}` : key),
      server: { registerTool: (name: string, _schema: unknown, handler: never) => handlers.set(name, handler) },
    } as unknown as McpToolContext)
    const read = await handlers.get('plan_read')!({ id: planRef(plan.id) })
    expect(read.content[0].text).toBe(`${planRef(plan.id)} · v1 · proposed · Only\n\n## Only\n- step`)
    const missing = await handlers.get('plan_read')!({ id: 'plan_00000000' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toBe(`returns.plans.notFound: ${planRef(plan.id)}`)
  })
})
