import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { HostService } from '../src/index.js'
import { readyBot, setup, until } from './bot-helpers.js'
const skipWindows = process.platform === 'win32'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})
async function context() {
  const ctx = await setup()
  cleanups.push(async () => {
    await ctx.service.close()
    await rm(ctx.dir, { recursive: true, force: true })
  })
  const bot = await readyBot(ctx)
  return { ...ctx, bot, guest: () => ctx.connector.guest(bot.vmId) }
}
describe.skipIf(skipWindows)('turns, approvals and recovery', () => {
  it('preserves legacy permissions when an old runtime cannot apply a blocklist', async () => {
    const ctx = await context()
    const before = await ctx.call('bot.network.inspect', { botId: ctx.bot.id })
    const legacy = await ctx.call('bot.network.update', { botId: ctx.bot.id, mode: 'allowlist', domains: ['example.com'], expectedRevision: before.policy.revision, idempotencyKey: 'legacy-policy' })
    ctx.guest().capabilities = ['provider.codex', 'tools.files']
    await expect(ctx.call('bot.network.update', { botId: ctx.bot.id, mode: 'blocklist', domains: [], expectedRevision: legacy.policy.revision, idempotencyKey: 'public-on-old-runtime' })).rejects.toMatchObject({ code: 'RUNTIME_UPDATE_REQUIRED' })
    expect((await ctx.call('bot.network.inspect', { botId: ctx.bot.id })).policy).toEqual(legacy.policy)
  })
  it('sends the persisted policy before login and restores offline policy after reconnect', async () => {
    const ctx = await context()
    const calls = ctx.guest().requests
    expect(calls[0]).toMatchObject({ method: 'policy.update', params: { permissionMode: 'ask', network: { mode: 'blocklist' } } })
    expect(calls.findIndex(r => r.method === 'policy.update')).toBeLessThan(calls.findIndex(r => r.method === 'auth.start'))
    const { policy } = await ctx.call('bot.network.inspect', { botId: ctx.bot.id })
    await ctx.call('bot.network.update', { botId: ctx.bot.id, mode: 'offline', domains: [], expectedRevision: policy.revision, idempotencyKey: 'offline-before-reconnect' })
    ctx.guest().drop()
    await ctx.call('bot.auth.status', { botId: ctx.bot.id })
    expect(ctx.guest().requests[0]).toMatchObject({ method: 'policy.update', params: { network: { mode: 'offline', domains: [] } } })
  })
  it('does not send login when the runtime refuses the persisted policy', async () => {
    const ctx = await context()
    ctx.guest().drop()
    ctx.connector.handler = async method => {
      if (method === 'policy.update') return { applied: false }
    }
    await expect(ctx.call('bot.auth.start', { botId: ctx.bot.id, method: 'device' })).rejects.toThrow()
    expect(ctx.guest().requests.some(r => r.method === 'auth.start')).toBe(false)
    expect(ctx.guest().alive).toBe(false)
  })
  it('persists the message before dispatch, returns the same receipt for repeats and refuses a second task', async () => {
    const ctx = await context()
    const receipt = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content: 'Faça um relatório' })
    expect(receipt.turn.status).toBe('queued')
    expect(await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content: 'Faça um relatório' })).toMatchObject({ turn: { id: receipt.turn.id } })
    await expect(ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content: 'outro' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm2', content: 'segunda' })).rejects.toMatchObject({ code: 'BOT_BUSY' })
    const running = await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'running')
    expect(running.leaseExpiresAt).toBeDefined()
    const dispatched = ctx.guest().requests.filter((r) => r.method === 'turn.start')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].params).toMatchObject({ turnId: receipt.turn.id, message: 'Faça um relatório', model: { model: 'fixture-small', effort: 'medium' }, permissionMode: 'ask', network: { mode: 'blocklist' } })
    expect(dispatched[0].params.instructions).toContain('Ajudar com relatórios')
    ctx.guest().finish(receipt.turn.id, 'succeeded', 'Relatório pronto em relatorio.md')
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'succeeded')
    const page = await ctx.call('bot.messages.list', { botId: ctx.bot.id })
    expect(page.messages.map((m: any) => [m.role, m.content])).toEqual([['user', 'Faça um relatório'], ['assistant', 'Relatório pronto em relatorio.md']])
    expect(page.conversation.providerThreadId).toBe('thread-1')
    expect((await ctx.call('bot.inspect', { botId: ctx.bot.id })).activeTurnId).toBeUndefined()
    const events = await ctx.call('bot.events.list', { botId: ctx.bot.id })
    expect(events.events.map((e: any) => e.kind)).toContain('assistant.message')
    expect(ctx.guest().acked.length).toBeGreaterThan(0)
    expect(await ctx.call('bot.messages.lookup', { botId: ctx.bot.id, clientMessageId: 'm1' })).toMatchObject({ turn: { status: 'succeeded' } })
  })
  it('routes approvals through interactions with single-use, generation-checked decisions', async () => {
    const ctx = await context()
    const receipt = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content: 'instale algo' })
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'running')
    let decided: string | undefined
    ctx.guest().interactions.set('act-1', (decision) => {
      decided = decision
    })
    ctx.guest().emit({ turnId: receipt.turn.id, generation: 1, kind: 'approval.requested', summary: 'Precisa de autorização', detail: { actionId: 'act-1', title: 'Executar com privilégios', reason: 'instalar pacote', consequence: 'altera o sistema', parameters: { command: 'apt install x' } } })
    const waiting = await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'waiting_approval')
    expect(waiting.status).toBe('waiting_approval')
    const [interaction] = await ctx.call('bot.interactions.list', { botId: ctx.bot.id })
    expect(interaction).toMatchObject({ kind: 'approval', title: 'Executar com privilégios', status: 'pending', parameters: { command: 'apt install x' } })
    await expect(ctx.call('bot.interactions.resolve', { interactionId: interaction.id, expectedGeneration: 2, decision: 'approve' })).rejects.toMatchObject({ code: 'INTERACTION_STALE' })
    await expect(ctx.call('bot.interactions.resolve', { interactionId: interaction.id, expectedGeneration: 1, decision: 'answer', answer: 'x' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const approved = await ctx.call('bot.interactions.resolve', { interactionId: interaction.id, expectedGeneration: 1, decision: 'approve' })
    expect(approved.status).toBe('approved')
    await until(() => Promise.resolve(decided), (d) => d === 'approve')
    await expect(ctx.call('bot.interactions.resolve', { interactionId: interaction.id, expectedGeneration: 1, decision: 'deny' })).rejects.toMatchObject({ code: 'INTERACTION_RESOLVED' })
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'running')
    // A question never changes permissions and is answered with text.
    ctx.guest().emit({ turnId: receipt.turn.id, generation: 1, kind: 'question.asked', summary: 'Pergunta', detail: { actionId: 'q-1', title: 'Qual formato?', question: 'PDF ou Markdown?' } })
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'waiting_input')
    const [question] = await ctx.call('bot.interactions.list', { botId: ctx.bot.id })
    await ctx.call('bot.interactions.resolve', { interactionId: question.id, expectedGeneration: 1, decision: 'answer', answer: 'Markdown' })
    expect(ctx.guest().requests.filter((r) => r.method === 'interaction.resolve').map((r) => r.params.decision)).toEqual(['approve', 'answer'])
    ctx.guest().finish(receipt.turn.id)
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'succeeded')
    expect((await ctx.call('bot.interactions.list', { botId: ctx.bot.id })).length).toBe(0)
  })
  it('cancels only after the guest confirms and invalidates pending approvals', async () => {
    const ctx = await context()
    const receipt = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content: 'tarefa longa' })
    const running = await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'running')
    ctx.guest().emit({ turnId: receipt.turn.id, generation: 1, kind: 'approval.requested', summary: 'x', detail: { actionId: 'a', title: 't', parameters: {} } })
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'waiting_approval')
    const current = await ctx.call('bot.turn.get', { turnId: receipt.turn.id })
    await expect(ctx.call('bot.turn.cancel', { turnId: receipt.turn.id, expectedRevision: running.revision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const cancelling = await ctx.call('bot.turn.cancel', { turnId: receipt.turn.id, expectedRevision: current.revision })
    expect(cancelling.status).toBe('cancelling')
    const cancelled = await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'cancelled')
    expect(cancelled.status).toBe('cancelled')
    expect((await ctx.call('bot.interactions.list', { botId: ctx.bot.id, pendingOnly: false }))[0].status).toBe('invalidated')
    expect(ctx.guest().requests.filter((r) => r.method === 'turn.cancel')).toHaveLength(1)
  })
  it('never re-sends turn.start after a lost reply or a Host restart; uncertain work needs attention until reconciled', async () => {
    const ctx = await context()
    // Lost reply: the guest accepted but the response never arrived.
    ctx.connector.handler = async (method, _params, guest) => {
      if (method === 'turn.start' && guest.requests.filter((r) => r.method === 'turn.start').length === 1) {
        guest.turns.set(_params.turnId, { status: 'running', snapshot: _params })
        throw new Error('RUNTIME_TIMEOUT')
      }
      return undefined
    }
    const receipt = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const turn = await ctx.call('bot.turn.get', { turnId: receipt.turn.id })
    expect(['starting', 'running']).toContain(turn.status)
    // Host restart: nothing replays; the turn is reconciled through the guest journal.
    await ctx.service.close()
    const reopened = new HostService(ctx.serviceOptions)
    cleanups.push(() => reopened.close())
    const call = async (method: string, params: unknown = {}) => {
      const r = await reopened.dispatch({ version: 1, id: 'x', method, params })
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
      return r.result as any
    }
    const reconciled = await until(() => call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'running' || t.status === 'succeeded', 8000)
    expect(reconciled.status).toBe('running')
    const guest = ctx.connector.guest(ctx.bot.vmId)
    expect(guest.turns.size).toBe(1)
    expect(guest.requests.filter((r) => r.method === 'turn.start')).toHaveLength(0)
    expect(guest.requests.some((r) => r.method === 'turn.reconcile')).toBe(true)
    guest.finish(receipt.turn.id)
    await until(() => call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'succeeded')
    const events = await call('bot.events.list', { botId: ctx.bot.id })
    expect(events.events.some((e: any) => e.kind === 'attention')).toBe(true)
  })
  it('marks a dropped channel as needing attention, reconnects, and reports interruption when the guest lost the turn', async () => {
    const ctx = await context()
    const receipt = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content: 'x' })
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'running')
    const guest = ctx.guest()
    guest.turns.clear() // the runtime rebooted and lost its journal for this turn
    guest.drop()
    const attention = await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status !== 'running')
    expect(['needs_attention', 'interrupted']).toContain(attention.status)
    const final = await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'interrupted', 15000)
    expect(final.error.code).toBe('INTERRUPTED')
    expect(ctx.connector.connections).toBeGreaterThan(1)
    // The bot is free again and the person can send a new task; nothing was auto-resent.
    const next = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm2', content: 'de novo' })
    expect(next.turn.id).not.toBe(receipt.turn.id)
  })
  it('blocks VM shutdown during active work with an explained conflict, but allows emergency shutdown of a stuck turn', async () => {
    const ctx = await context()
    const receipt = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content: 'x' })
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'running')
    const vm = await ctx.call('vm.inspect', { vmId: ctx.bot.vmId })
    await expect(ctx.call('vm.shutdown', { vmId: vm.id, expectedRevision: vm.revision, idempotencyKey: 'stop' })).rejects.toMatchObject({ code: 'BOT_ACTIVE' })
    const current = await ctx.call('bot.turn.get', { turnId: receipt.turn.id })
    ctx.connector.handler = async (method) => (method === 'turn.cancel' ? { cancelled: false } : undefined)
    await ctx.call('bot.turn.cancel', { turnId: receipt.turn.id, expectedRevision: current.revision })
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'cancelling')
    const latest = await ctx.call('vm.inspect', { vmId: ctx.bot.vmId })
    const op = await ctx.call('vm.shutdown', { vmId: vm.id, expectedRevision: latest.revision, idempotencyKey: 'stop2' })
    await until(() => ctx.call('operation.get', { operationId: op.id }), (o: any) => o.status === 'succeeded')
    const interrupted = await ctx.call('bot.turn.get', { turnId: receipt.turn.id })
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.error.code).toBe('VM_STOPPED')
    // Sending is accepted durably; dispatch waits until the computer is started again, nothing is lost.
    const next = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm2', content: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(['queued', 'needs_attention']).toContain((await ctx.call('bot.turn.get', { turnId: next.turn.id })).status)
    const stopped = await ctx.call('vm.inspect', { vmId: ctx.bot.vmId })
    const start = await ctx.call('vm.start', { vmId: stopped.id, expectedRevision: stopped.revision, idempotencyKey: 'start' })
    await until(() => ctx.call('operation.get', { operationId: start.id }), (o: any) => o.status === 'succeeded')
    await until(() => ctx.call('bot.turn.get', { turnId: next.turn.id }), (t: any) => t.status === 'running')
  })
  it('keeps chat content intact and rejects full-vm without confirmation', async () => {
    const ctx = await context()
    const content = `${'/home/maestrlybot/workspace/relatorio.md '.repeat(10)}${'x'.repeat(5000)}`
    const receipt = await ctx.call('bot.messages.send', { botId: ctx.bot.id, clientMessageId: 'm1', content })
    expect((await ctx.call('bot.messages.list', { botId: ctx.bot.id })).messages[0].content).toBe(content)
    await expect(ctx.call('bot.update', { botId: ctx.bot.id, expectedRevision: (await ctx.call('bot.inspect', { botId: ctx.bot.id })).revision, permissionMode: 'full-vm' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    ctx.guest().finish(receipt.turn.id)
    await until(() => ctx.call('bot.turn.get', { turnId: receipt.turn.id }), (t: any) => t.status === 'succeeded')
    const bot = await ctx.call('bot.inspect', { botId: ctx.bot.id })
    const updated = await ctx.call('bot.update', { botId: ctx.bot.id, expectedRevision: bot.revision, permissionMode: 'full-vm', confirmFullVm: true })
    expect(updated.permissionMode).toBe('full-vm')
  })
})
