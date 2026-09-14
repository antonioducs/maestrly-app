import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

/** Uses only already-created, explicitly selected-VM bots. No account import or implicit setup. */
export async function sharedSessionLab(config, directory, flags, api) {
  if (!config.botVmId) throw Error('SELECTED_VM_REQUIRED')
  const host = await api('host.inspect', {})
  if (!host.capabilities.includes('bot.sessions.v1')) return { status: 'blocked', reason: 'Atualize o Host para usar áreas de trabalho independentes.' }
  const inventory = await api('bot.sessions.list', { vmId: config.botVmId })
  const bots = (await api('bot.list', {})).filter(b => b.vmId === config.botVmId && b.status === 'ready')
  const ready = bots.filter(b => inventory.sessions.some(s => s.botId === b.id && s.transport === 'managed'))
  if (!flags.includes('--authorize-bot-smoke')) return { status: inventory.supported ? 'supported' : 'blocked', readyBots: ready.length, availableSessions: inventory.available, reason: inventory.reason }
  if (config.authorizeBotSmoke !== true) throw Error('BOT_SMOKE_NOT_AUTHORIZED')
  if (ready.length < 2) return { status: 'blocked', reason: 'Crie o segundo bot nesta VM e conecte sua conta de IA no aplicativo.' }
  const selected = ready.slice(0, 2)
  if (selected.some(b => b.activeTurnId)) throw Error('BOT_BUSY: finish both tasks before the paired smoke')
  for (const b of selected) if ((await api('bot.auth.status', { botId: b.id })).state !== 'connected') return { status: 'blocked', reason: 'Conecte a conta de IA dos dois bots antes do teste.' }
  const intentPath = join(directory, 'shared-intent.json')
  let intents
  try { intents = JSON.parse(await readFile(intentPath, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    intents = selected.map((bot, i) => ({ hostId: host.id, botId: bot.id, clientMessageId: randomUUID(), label: i === 0 ? 'A' : 'B', color: i === 0 ? '#682121' : '#183c68' }))
    await writeFile(intentPath, JSON.stringify(intents, null, 2), { flag: 'wx', mode: 0o600 })
  }
  if (intents.some(i => i.hostId !== host.id || !selected.some(b => b.id === i.botId))) throw Error('SMOKE_IDENTITY_CHANGED')
  const accepted = await Promise.all(intents.map(async intent => {
    const existing = await api('bot.messages.lookup', { botId: intent.botId, clientMessageId: intent.clientMessageId })
    if (existing) return existing
    return api('bot.messages.send', {
      botId: intent.botId, clientMessageId: intent.clientMessageId,
      content: `Verificação da sua área de trabalho independente (${intent.label}): crie no workspace uma página HTML local com fundo ${intent.color}, título grande "Sessão ${intent.label}", um botão e um campo de texto. Abra no navegador desta sessão. Use as ferramentas computer_screenshot, computer_click e computer_type para clicar no botão e digitar "teste-${intent.label}" no campo; observe novamente entre ações. Entregue uma captura final da área de trabalho usando computer_screenshot e files_deliver. Não use internet, não altere permissões e não acesse outros diretórios.`,
    })
  }))
  await writeFile(join(directory, 'shared-receipts.json'), JSON.stringify(accepted, null, 2), { mode: 0o600 })
  const deadline = Date.now() + 15 * 60_000
  let turns
  while (Date.now() < deadline) {
    turns = await Promise.all(accepted.map(r => api('bot.turn.get', { turnId: r.turn.id })))
    if (turns.every(t => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(t.status))) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  if (!turns?.every(t => t.status === 'succeeded')) return { status: 'blocked', reason: 'Uma tarefa não concluiu; inspecione os turnos registrados antes de repetir.', turns: turns?.map(t => ({ id: t.id, status: t.status })) }
  const captures = []
  for (const [i, intent] of intents.entries()) {
    const events = []; let after = 0, more = true
    while (more) { const page = await api('bot.events.list', { botId: intent.botId, after }); events.push(...page.events.filter(e => e.turnId === accepted[i].turn.id)); after = page.cursor; more = page.hasMore }
    if (!events.some(e => e.kind === 'tool.finished' && e.detail?.name === 'computer_screenshot' && !e.detail?.isError)) throw Error('COMPUTER_EVIDENCE_MISSING')
    const shot = events.filter(e => e.kind === 'file.produced' && typeof e.detail?.path === 'string' && e.detail.path.endsWith('.png')).at(-1)
    if (!shot) throw Error('SCREENSHOT_MISSING')
    let transfer = await api('bot.files.transferBegin', { botId: intent.botId, direction: 'download', path: shot.detail.path })
    const chunks = []
    while (!transfer.done) { transfer = await api('bot.files.transferChunk', { transferId: transfer.transferId, offset: transfer.offset }); if (transfer.dataBase64) chunks.push(Buffer.from(transfer.dataBase64, 'base64')) }
    const bytes = Buffer.concat(chunks), hash = createHash('sha256').update(bytes).digest('hex')
    if (hash !== transfer.digest || bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== 1280 || bytes.readUInt32BE(20) !== 800) throw Error('SCREENSHOT_INVALID')
    await api('bot.files.transferFinish', { transferId: transfer.transferId })
    await writeFile(join(directory, `session-${intent.label}.png`), bytes, { mode: 0o600 })
    captures.push({ label: intent.label, sha256: hash, size: bytes.length })
  }
  if (captures[0].sha256 === captures[1].sha256) throw Error('SCREENSHOTS_IDENTICAL')
  return { status: 'captured', providerTurnsSucceeded: true, captures, visualReviewRequired: true }
}
