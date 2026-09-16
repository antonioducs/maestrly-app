import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TURN_LIMITS } from '../src/bots/context.js'
import { readyBot, setup, until, FakeConnector } from './bot-helpers.js'
import { DesktopConnector, token } from './desktop-helpers.js'

async function managedBot() {
  const connector = new DesktopConnector()
  const ctx = await setup({ connector })
  const bot = await readyBot(ctx)
  const call = async (method: string, params: unknown = {}, connectionId = 'app-1') => {
    const response = await ctx.service.dispatch({ version: 1, id: randomUUID(), method, params }, { connectionId })
    if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result as any
  }
  const session = await ctx.call('bot.session.inspect', { botId: bot.id })
  return { ...ctx, connector, bot, call, session }
}
async function startTask(f: Awaited<ReturnType<typeof managedBot>>, content = 'Preencha o formulário') {
  const receipt = await f.call('bot.messages.send', { botId: f.bot.id, clientMessageId: randomUUID(), content })
  await until(() => f.call('bot.turn.get', { turnId: receipt.turn.id }), (turn: any) => turn.status === 'running')
  return receipt.turn.id as string
}
async function takeControl(f: Awaited<ReturnType<typeof managedBot>>, connectionId = 'app-1') {
  const opened = await f.call('bot.desktop.open', { botId: f.bot.id, clientInstanceId: 'window-1' }, connectionId)
  const operation = await f.call('bot.desktop.acquire', { viewId: opened.viewId, expectedRevision: opened.state.revision, idempotencyKey: randomUUID() }, connectionId)
  const done = await until(() => f.call('bot.desktop.operation.get', { operationId: operation.id }), (op: any) => op.status !== 'running')
  return { opened, operation: done }
}

describe('live desktop handoff through the Host', () => {
  it('legacy environments ask for an update instead of degrading to an insecure view', async () => {
    const ctx = await setup({ connector: new FakeConnector() })
    const bot = await readyBot(ctx)
    await expect(ctx.call('bot.desktop.inspect', { botId: bot.id })).rejects.toMatchObject({ code: 'DESKTOP_UPDATE_REQUIRED' })
    await expect(ctx.call('bot.desktop.open', { botId: bot.id, clientInstanceId: 'w' })).rejects.toMatchObject({ code: 'DESKTOP_UPDATE_REQUIRED' })
    expect((await ctx.call('host.inspect')).capabilities).toEqual(expect.arrayContaining(['desktop.live.v1', 'desktop.handoff.v1']))
    expect((await ctx.call('host.inspect')).capabilities).not.toContain('bot.desktop.v1')
  })
  it('viewing is read-only and never creates a turn; tickets are single use and bound to the Host', async () => {
    const f = await managedBot()
    const state = await f.call('bot.desktop.inspect', { botId: f.bot.id })
    expect(state).toMatchObject({ mode: 'bot', available: true, capabilities: ['desktop.live.v1', 'desktop.handoff.v1'], controlled: false })
    const turnsBefore = (await f.call('bot.messages.list', { botId: f.bot.id })).turns.length
    const opened = await f.call('bot.desktop.open', { botId: f.bot.id, clientInstanceId: 'window-1' })
    expect(opened.mediaTicket).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(opened.state)).not.toContain(opened.mediaTicket)
    const media = await f.service.attachDesktop(opened.mediaTicket)
    const greeting = await new Promise<string>((resolve) => media.stream.once('data', (bytes) => resolve(bytes.toString())))
    expect(greeting).toBe('RFB 003.008\n')
    await expect(f.service.attachDesktop(opened.mediaTicket)).rejects.toMatchObject({ code: 'TICKET_INVALID' })
    await expect(f.service.attachDesktop('d'.repeat(64))).rejects.toMatchObject({ code: 'TICKET_INVALID' })
    expect((await f.call('bot.messages.list', { botId: f.bot.id })).turns.length).toBe(turnsBefore)
    // A viewer cannot inject input, even with a guessed capability.
    await expect(f.call('bot.desktop.input', { viewId: opened.viewId, controlCapability: token(), controlEpoch: 0, desktopGeneration: 'desktop-gen-1', sequence: 0, events: [{ kind: 'pointer', x: 1, y: 1 }] })).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
    // Viewers are bound to their Host connection.
    await expect(f.call('bot.desktop.renew', { viewId: opened.viewId }, 'app-2')).rejects.toMatchObject({ code: 'DESKTOP_UNAVAILABLE' })
    expect(f.connector.applied).toEqual([])
  })
  it('taking control interrupts the task, blocks new work and only then grants one controller', async () => {
    const f = await managedBot()
    const turnId = await startTask(f)
    const { opened, operation } = await takeControl(f)
    expect(operation).toMatchObject({ kind: 'acquire', status: 'succeeded', interruptedTurnId: turnId })
    expect(f.connector.calls.map((c) => c.method).slice(0, 4)).toEqual(['desktop.viewer.open', 'desktop.hold', 'desktop.acquire', ...(f.connector.calls.length > 3 ? [f.connector.calls[3].method] : [])].slice(0, 4))
    const turn = await f.call('bot.turn.get', { turnId })
    expect(turn).toMatchObject({ status: 'interrupted', error: { code: 'HUMAN_TAKEOVER' } })
    await expect(f.call('bot.messages.send', { botId: f.bot.id, clientMessageId: randomUUID(), content: 'nova tarefa' })).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
    const claim = await f.call('bot.desktop.claimControl', { viewId: opened.viewId, operationId: operation.id })
    expect(claim).toMatchObject({ controlEpoch: operation.controlEpoch, desktopGeneration: 'desktop-gen-1', leaseMs: 12_000, renewMs: 3_000, state: { mode: 'human', controlled: true, interruptedTurnId: turnId } })
    const input = (sequence: number, extra = {}) => f.call('bot.desktop.input', { viewId: opened.viewId, controlCapability: claim.controlCapability, controlEpoch: claim.controlEpoch, desktopGeneration: claim.desktopGeneration, sequence, events: [{ kind: 'text', text: 'ação' }], ...extra })
    await expect(input(0)).resolves.toEqual({ sequence: 0, applied: 1 })
    await expect(input(0)).resolves.toEqual({ sequence: 0, applied: 1 })
    expect(f.connector.applied).toHaveLength(1)
    await expect(input(1, { desktopGeneration: 'other-gen' })).rejects.toMatchObject({ code: 'STALE_DESKTOP' })
    // A second authorized client can watch but not take over silently.
    const other = await f.call('bot.desktop.open', { botId: f.bot.id, clientInstanceId: 'window-2' }, 'app-2')
    await expect(f.call('bot.desktop.acquire', { viewId: other.viewId, expectedRevision: other.state.revision, idempotencyKey: randomUUID() }, 'app-2')).rejects.toMatchObject({ code: 'CONTROL_BUSY' })
    await expect(f.call('bot.desktop.input', { viewId: other.viewId, controlCapability: claim.controlCapability, controlEpoch: claim.controlEpoch, desktopGeneration: claim.desktopGeneration, sequence: 5, events: [{ kind: 'releaseAll' }] }, 'app-2')).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
    // The automation worker is not reconnected while the person holds the desktop.
    const connections = f.connector.connections
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(f.connector.connections).toBe(connections)
  })
  it('returning continues the task once, from a fresh capture and with only the remaining budget', async () => {
    const f = await managedBot()
    const turnId = await startTask(f)
    const { opened, operation } = await takeControl(f)
    const claim = await f.call('bot.desktop.claimControl', { viewId: opened.viewId, operationId: operation.id })
    await f.call('bot.desktop.input', { viewId: opened.viewId, controlCapability: claim.controlCapability, controlEpoch: claim.controlEpoch, desktopGeneration: claim.desktopGeneration, sequence: 0, events: [{ kind: 'text', text: 'corrigido' }] })
    const key = randomUUID()
    const params = { botId: f.bot.id, viewId: opened.viewId, controlCapability: claim.controlCapability, expectedRevision: claim.state.revision, idempotencyKey: key, continueTask: true }
    const returned = await f.call('bot.desktop.return', params)
    // Input is revoked the moment return is accepted.
    await expect(f.call('bot.desktop.input', { viewId: opened.viewId, controlCapability: claim.controlCapability, controlEpoch: claim.controlEpoch, desktopGeneration: claim.desktopGeneration, sequence: 1, events: [{ kind: 'releaseAll' }] })).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
    const done = await until(() => f.call('bot.desktop.operation.get', { operationId: returned.id }), (op: any) => op.status !== 'running')
    expect(done).toMatchObject({ status: 'succeeded', kind: 'return', continuationTurnId: expect.any(String) })
    expect(f.connector.calls.map((c) => c.method).filter((m) => ['desktop.release', 'desktop.capture', 'desktop.resume'].includes(m))).toEqual(['desktop.release', 'desktop.capture', 'desktop.resume'])
    const start = await until(async () => f.connector.guest(f.bot.vmId, f.session.id).requests.find((r) => r.method === 'turn.start' && r.params.turnId === done.continuationTurnId), (value) => !!value)
    expect(start!.params.message).toContain('Continuação após intervenção humana')
    expect(start!.params.message).toContain('Preencha o formulário')
    expect(start!.params.attachments).toEqual([expect.stringMatching(/^\.maestrly\/screens\/[a-f0-9-]{36}\.png$/)])
    expect(start!.params.limits.activeMs).toBeLessThanOrEqual(TURN_LIMITS.activeMs)
    expect(start!.params.turnId).not.toBe(turnId)
    const state = await f.call('bot.desktop.inspect', { botId: f.bot.id })
    expect(state).toMatchObject({ mode: 'bot', controlled: false })
    expect(state.interruptedTurnId).toBeUndefined()
    // Retrying the same return never creates a second continuation.
    expect(await f.call('bot.desktop.return', params)).toMatchObject({ id: returned.id })
    const turns = (await f.call('bot.messages.list', { botId: f.bot.id })).turns
    expect(turns.filter((t: any) => t.id === done.continuationTurnId)).toHaveLength(1)
    expect(f.connector.count('desktop.capture')).toBe(1)
  })
  it('losing the controller pauses the bot; nothing resumes until an explicit return', async () => {
    const f = await managedBot()
    await startTask(f)
    const { opened, operation } = await takeControl(f)
    await f.call('bot.desktop.claimControl', { viewId: opened.viewId, operationId: operation.id })
    await f.service.disconnect('app-1')
    const paused = await f.call('bot.desktop.inspect', { botId: f.bot.id }, 'app-2')
    expect(paused).toMatchObject({ mode: 'paused', controlled: false, reasonCode: 'CONTROLLER_DISCONNECTED' })
    expect(f.connector.hold(f.session.id).mode).toBe('paused')
    await expect(f.call('bot.messages.send', { botId: f.bot.id, clientMessageId: randomUUID(), content: 'x' }, 'app-2')).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
    // A definitive decision not to continue: control returns without resurrecting the task.
    const returned = await f.call('bot.desktop.return', { botId: f.bot.id, expectedRevision: paused.revision, idempotencyKey: randomUUID(), continueTask: false }, 'app-2')
    const done = await until(() => f.call('bot.desktop.operation.get', { operationId: returned.id }, 'app-2'), (op: any) => op.status !== 'running')
    expect(done.status).toBe('succeeded')
    expect(done.continuationTurnId).toBeUndefined()
    expect(f.connector.count('desktop.capture')).toBe(0)
    expect(await f.call('bot.desktop.inspect', { botId: f.bot.id }, 'app-2')).toMatchObject({ mode: 'bot' })
    const receipt = await f.call('bot.messages.send', { botId: f.bot.id, clientMessageId: randomUUID(), content: 'nova tarefa' }, 'app-2')
    expect(receipt.turn.status).toBe('queued')
  })
  it('an idle bot is simply released, without calling the model', async () => {
    const f = await managedBot()
    const { opened, operation } = await takeControl(f)
    expect(operation.interruptedTurnId).toBeUndefined()
    const claim = await f.call('bot.desktop.claimControl', { viewId: opened.viewId, operationId: operation.id })
    const returned = await f.call('bot.desktop.return', { botId: f.bot.id, viewId: opened.viewId, controlCapability: claim.controlCapability, expectedRevision: claim.state.revision, idempotencyKey: randomUUID(), continueTask: true })
    const done = await until(() => f.call('bot.desktop.operation.get', { operationId: returned.id }), (op: any) => op.status !== 'running')
    expect(done).toMatchObject({ status: 'succeeded' })
    expect(done.continuationTurnId).toBeUndefined()
    expect(f.connector.count('desktop.capture')).toBe(0)
    expect(f.connector.guest(f.bot.vmId, f.session.id).requests.filter((r) => r.method === 'turn.start')).toHaveLength(0)
  })
  it('a task that finished during the takeover keeps its real result and is not continued', async () => {
    const f = await managedBot()
    const turnId = await startTask(f)
    f.connector.onHold = () => f.connector.guest(f.bot.vmId, f.session.id).finish(turnId, 'succeeded', 'pronto')
    const { opened, operation } = await takeControl(f)
    expect((await f.call('bot.turn.get', { turnId })).status).toBe('succeeded')
    expect(operation.interruptedTurnId).toBeUndefined()
    const claim = await f.call('bot.desktop.claimControl', { viewId: opened.viewId, operationId: operation.id })
    const returned = await f.call('bot.desktop.return', { botId: f.bot.id, viewId: opened.viewId, controlCapability: claim.controlCapability, expectedRevision: claim.state.revision, idempotencyKey: randomUUID(), continueTask: true })
    const done = await until(() => f.call('bot.desktop.operation.get', { operationId: returned.id }), (op: any) => op.status !== 'running')
    expect(done.continuationTurnId).toBeUndefined()
  })
  it('an unconfirmed stop leaves the bot blocked instead of handing over input', async () => {
    const f = await managedBot()
    await startTask(f)
    f.connector.failAcquire = true
    const { opened, operation } = await takeControl(f)
    expect(operation).toMatchObject({ status: 'failed', failureCode: 'HANDOFF_UNCERTAIN' })
    await expect(f.call('bot.desktop.claimControl', { viewId: opened.viewId, operationId: operation.id })).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' })
    const state = await f.call('bot.desktop.inspect', { botId: f.bot.id })
    expect(state).toMatchObject({ mode: 'blocked', reasonCode: 'HANDOFF_UNCERTAIN' })
    await expect(f.call('bot.messages.send', { botId: f.bot.id, clientMessageId: randomUUID(), content: 'x' })).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
  })
  it('a Host restart never restores a controller and never resumes on its own', async () => {
    const f = await managedBot()
    const { opened, operation } = await takeControl(f)
    await f.call('bot.desktop.claimControl', { viewId: opened.viewId, operationId: operation.id })
    await f.service.close()
    const again = await setup({ dir: f.dir, connector: f.connector, provider: f.provider })
    const state = await again.call('bot.desktop.inspect', { botId: f.bot.id })
    expect(state).toMatchObject({ mode: 'paused', reasonCode: 'HOST_RESTARTED', controlled: false })
    await expect(again.call('bot.messages.send', { botId: f.bot.id, clientMessageId: randomUUID(), content: 'x' })).rejects.toMatchObject({ code: 'BOT_PAUSED_BY_USER' })
    await again.service.close()
  })
  it('bounds viewers per bot and per Host', async () => {
    const f = await managedBot()
    await f.call('bot.desktop.open', { botId: f.bot.id, clientInstanceId: 'a' })
    await f.call('bot.desktop.open', { botId: f.bot.id, clientInstanceId: 'b' })
    await expect(f.call('bot.desktop.open', { botId: f.bot.id, clientInstanceId: 'c' })).rejects.toMatchObject({ code: 'VIEWER_LIMIT' })
  })
})
