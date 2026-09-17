import { usageResultSchemas, usageWindowProblem, type UsageMethod, type UsageRequest, type UsageResult, type UsageSummary } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { BotRepository, TurnUsageRow } from '../bots/repository.js'

const zero = () => ({ turns: 0, input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, toolCalls: 0 })
type Tokens = ReturnType<typeof zero>
const add = (into: Tokens, row: TurnUsageRow) => {
  into.turns += 1
  into.input += row.input
  into.cachedInput += row.cachedInput
  into.output += row.output
  into.reasoningOutput += row.reasoningOutput
  into.toolCalls += row.toolCalls
}

/**
 * Sums the turn ledger over a bounded window. Nothing is priced here: prices change and live in
 * a public catalogue the application reads; the Host only counts what its bots actually used.
 */
export class UsageService {
  constructor(
    private readonly bots: BotRepository,
    private readonly clock: () => Date = () => new Date()
  ) {}
  async handle<M extends UsageMethod>(request: Extract<UsageRequest, { method: M }>): Promise<UsageResult<M>> {
    const p = request.params as { botId?: string; since: string; until?: string }
    return usageResultSchemas[request.method].parse(this.summary(p)) as UsageResult<M>
  }
  summary(p: { botId?: string; since: string; until?: string }): UsageSummary {
    const until = p.until ?? this.clock().toISOString()
    if (usageWindowProblem(p.since, until)) throw new HostError('USAGE_RANGE_INVALID', 'O período pedido é inválido ou passa de 90 dias')
    const since = new Date(Date.parse(p.since)).toISOString()
    const end = new Date(Date.parse(until)).toISOString()
    if (p.botId && this.bots.botName(p.botId) === undefined) throw new HostError('NOT_FOUND', 'Bot not found')
    const rows = this.bots.turnUsage(p.botId, since, end)
    const totals = zero()
    const byModel = new Map<string, UsageSummary['byModel'][number]>()
    const byBot = new Map<string, UsageSummary['byBot'][number]>()
    const byDay = new Map<string, UsageSummary['byDay'][number]>()
    const names = new Map<string, string>()
    for (const row of rows) {
      add(totals, row)
      const modelKey = `${row.provider}\0${row.model}`
      const model = byModel.get(modelKey) ?? { provider: row.provider, model: row.model, ...zero() }
      add(model, row)
      byModel.set(modelKey, model)
      // An archived or purged bot keeps its rows in the ledger; only its name may be gone.
      if (!names.has(row.botId)) names.set(row.botId, this.bots.botName(row.botId) ?? '')
      const bot = byBot.get(row.botId) ?? { botId: row.botId, name: names.get(row.botId) ?? '', ...zero() }
      add(bot, row)
      byBot.set(row.botId, bot)
      const dayKey = row.finishedAt.slice(0, 10)
      const day = byDay.get(dayKey) ?? { day: dayKey, ...zero() }
      add(day, row)
      byDay.set(dayKey, day)
    }
    return {
      since,
      until: end,
      ...(p.botId ? { botId: p.botId } : {}),
      ...totals,
      ...(rows.length ? { firstAt: rows[0].finishedAt, lastAt: rows[rows.length - 1].finishedAt } : {}),
      byModel: [...byModel.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
      byBot: [...byBot.values()].sort((a, b) => b.input + b.output - (a.input + a.output)),
      byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    }
  }
}
