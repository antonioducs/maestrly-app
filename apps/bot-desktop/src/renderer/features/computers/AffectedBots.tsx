import { useEffect, useState } from 'react'
import type { Bot } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
export function AffectedBots({ vmId }: { vmId: string }) {
  const [bots, setBots] = useState<Bot[]>([])
  const t = useT()
  useEffect(() => {
    let active = true
    void window.bot.bot({ method: 'bot.list', params: { includeArchived: true } }).then(bots => { if (active) setBots(bots.filter(bot => bot.vmId === vmId)) }).catch(() => {})
    return () => { active = false }
  }, [vmId])
  if (!bots.length) return null
  return <section className="affected-bots"><h3>{t('botsOnComputer')}</h3><ul>{bots.map(bot => <li key={bot.id}>{bot.name}</li>)}</ul><p>{t('sharedVmWarning')}</p></section>
}
