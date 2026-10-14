import type { FleetBot, FleetSelectionOption } from '@maestrly/bot-fleet-protocol'
import type { Translate } from '../i18n/translate'
import { effortLabel } from './format'

/** Models under their provider, in the order the server lists them; a search matches providers and models. */
export function groupOptions(
  options: FleetSelectionOption[],
  query: string
): { provider: string; options: FleetSelectionOption[] }[] {
  const q = query.trim().toLowerCase()
  const groups: { provider: string; options: FleetSelectionOption[] }[] = []
  for (const option of options) {
    if (q && !`${option.providerLabel} ${option.modelLabel}`.toLowerCase().includes(q)) continue
    const group = groups.find((item) => item.provider === option.providerLabel)
    if (group) group.options.push(option)
    else groups.push({ provider: option.providerLabel, options: [option] })
  }
  return groups
}

/**
 * The efforts a model offers, after Default (null, the model's own); none when it has no levels. Bots never run
 * Ultra, as on the desktop, so an Ultra level a server might list is left out.
 */
export function effortChoices(option: FleetSelectionOption): (string | null)[] {
  const efforts = option.efforts.filter((effort) => !effort.includes('ultra'))
  return efforts.length ? [null, ...efforts] : []
}

/** The model a bot uses and its effort, as the composer and the bot details show it. */
export function setupSummary(bot: FleetBot, option: FleetSelectionOption | null, t: Translate): string {
  const selection = bot.selection
  if (!selection) return t('setup.botDefault')
  const model = option?.modelLabel ?? selection.modelId
  return selection.reasoning ? `${model} · ${effortLabel(selection.reasoning, t)}` : model
}
