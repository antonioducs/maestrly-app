import { Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Bot, BotSession, Vm } from '@maestrly/host-protocol'
import { Button } from '../../ui'
import { useT } from '../../i18n'
export function BotComputer({ bot, onOpenDesktop }: { bot: Bot; onOpenDesktop?: () => void }) {
  const t = useT()
  const [value, setValue] = useState<{ session: BotSession; vm: Vm }>()
  useEffect(() => {
    let active = true
    setValue(undefined)
    if (bot.vmId) void Promise.all([
      window.bot.bot({ method: 'bot.session.inspect', params: { botId: bot.id } }),
      window.bot.call({ method: 'vm.inspect', params: { vmId: bot.vmId } }) as Promise<Vm>,
    ]).then(([session, vm]) => { if (active && session?.transport === 'managed') setValue({ session, vm }) }).catch(() => {})
    return () => { active = false }
  }, [bot.id, bot.vmId])
  if (!value) return null
  return (
    <div className="bot-computer-summary">
      <Monitor size={16} aria-hidden="true" />
      <div>
        <strong>{t('privateWorkspace')}</strong>
        <p>{value.vm.name}</p>
        <small>{t('sharedComputerExplanation')}</small>
        {onOpenDesktop && <p><Button onClick={onOpenDesktop}>{t('viewScreen')}</Button></p>}
      </div>
    </div>
  )
}
