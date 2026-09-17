import { usageWindowProblem, type Bot, type BotTurn, type UsageSummary } from '@maestrly/host-protocol'
import { HostRequestError } from './host-client'

const fail = (code: string, message: string) => new HostRequestError(message, code)
type Tokens = { turns: number; input: number; cachedInput: number; output: number; reasoningOutput: number; toolCalls: number }
const zero = (): Tokens => ({ turns: 0, input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, toolCalls: 0 })
const add = (into: Tokens, turn: BotTurn) => {
  into.turns += 1
  into.input += turn.usage?.inputTokens ?? 0
  into.cachedInput += turn.usage?.cachedInputTokens ?? 0
  into.output += turn.usage?.outputTokens ?? 0
  into.reasoningOutput += turn.usage?.reasoningOutputTokens ?? 0
  into.toolCalls += turn.usage?.toolCalls ?? 0
}

/** The Host's summary, computed the same way over the fixture's finished turns. */
export class FixtureUsage {
  constructor(
    private readonly turns: () => BotTurn[],
    private readonly bot: (id: string) => Bot | undefined
  ) {}
  request(method: string, p: Record<string, unknown>): unknown {
    if (method !== 'usage.summary') throw fail('INVALID_REQUEST', `Unsupported fixture method ${method}`)
    const since = String(p.since)
    const until = typeof p.until === 'string' ? p.until : new Date().toISOString()
    if (usageWindowProblem(since, until)) throw fail('USAGE_RANGE_INVALID', 'O período pedido é inválido ou passa de 90 dias')
    const botId = typeof p.botId === 'string' ? p.botId : undefined
    if (botId && !this.bot(botId)) throw fail('NOT_FOUND', 'Bot not found')
    const rows = this.turns()
      .filter((turn) => turn.usage && turn.finishedAt && turn.finishedAt >= since && turn.finishedAt <= until && (!botId || turn.botId === botId))
      .sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!))
    const totals = zero()
    const byModel = new Map<string, UsageSummary['byModel'][number]>()
    const byBot = new Map<string, UsageSummary['byBot'][number]>()
    const byDay = new Map<string, UsageSummary['byDay'][number]>()
    for (const turn of rows) {
      add(totals, turn)
      const model = turn.model?.model ?? this.bot(turn.botId)?.model?.model ?? 'unknown'
      const m = byModel.get(model) ?? { provider: 'codex', model, ...zero() }
      add(m, turn)
      byModel.set(model, m)
      const b = byBot.get(turn.botId) ?? { botId: turn.botId, name: this.bot(turn.botId)?.name ?? '', ...zero() }
      add(b, turn)
      byBot.set(turn.botId, b)
      const day = turn.finishedAt!.slice(0, 10)
      const d = byDay.get(day) ?? { day, ...zero() }
      add(d, turn)
      byDay.set(day, d)
    }
    const summary: UsageSummary = {
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      ...(botId ? { botId } : {}),
      ...totals,
      ...(rows.length ? { firstAt: rows[0].finishedAt!, lastAt: rows[rows.length - 1].finishedAt! } : {}),
      byModel: [...byModel.values()],
      byBot: [...byBot.values()],
      byDay: [...byDay.values()],
    }
    return summary
  }
}
