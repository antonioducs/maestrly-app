import { ChevronRight, Activity as ActivityIcon } from 'lucide-react'
import { Button } from '../../ui'
import { useState } from 'react'
import type { BotEvent } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
export function Activity({ events }: { events: BotEvent[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [technical, setTechnical] = useState(false)
  const summaries = events
    .filter((event) => ['tool.started', 'tool.finished', 'assistant.delta'].includes(event.kind))
    .slice(-12)
  if (!summaries.length) return null
  return (
    <section className="activity">
      <Button
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          setTechnical(false)
        }}
      >
        <ChevronRight size={13} style={{ transform: open ? 'rotate(90deg)' : undefined }} aria-hidden="true" /><ActivityIcon size={13} aria-hidden="true" />{t('activity')}
      </Button>
      {open && (
        <>
          <ul>
            {summaries
              .filter(
                (event, index) => event.kind !== 'assistant.delta' || summaries[index - 1]?.kind !== 'assistant.delta'
              )
              .map((event) => (
                <li key={event.seq}>{event.kind === 'assistant.delta' ? t('writing') : event.summary}</li>
              ))}
          </ul>
          <Button aria-expanded={technical} onClick={() => setTechnical(!technical)}>
            {t('technical')}
          </Button>
          {technical && <pre>{JSON.stringify(events.slice(-30), null, 2)}</pre>}
        </>
      )}
    </section>
  )
}
