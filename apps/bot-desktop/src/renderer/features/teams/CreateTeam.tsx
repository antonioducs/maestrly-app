import { useState } from 'react'
import type { Bot } from '@maestrly/host-protocol'
import { Button, Input, Textarea } from '../../ui'
import { useT } from '../../i18n'

type Draft = { botId: string; role: string }
/**
 * Creating a team asks only what a person can answer: a name, which bots take part and who
 * organises the work. It never asks about computers, sessions, resources or protocol, and
 * it never creates a bot or a VM — it links bots that already exist.
 */
export function CreateTeam({ bots, onCancel, onCreated }: { bots: Bot[]; onCancel: () => void; onCreated: (teamId: string) => void }) {
  const t = useT()
  const available = bots.filter((bot) => bot.status === 'ready')
  const [name, setName] = useState('')
  const [objective, setObjective] = useState('')
  const [members, setMembers] = useState<Draft[]>(() => available.slice(0, 2).map((bot) => ({ botId: bot.id, role: '' })))
  const [coordinatorBotId, setCoordinatorBotId] = useState(available[0]?.id ?? '')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const toggle = (botId: string) => {
    setMembers((current) => {
      const next = current.some((member) => member.botId === botId) ? current.filter((member) => member.botId !== botId) : [...current, { botId, role: '' }]
      // The coordinator always stays one of the chosen bots.
      if (!next.some((member) => member.botId === coordinatorBotId)) setCoordinatorBotId(next[0]?.botId ?? '')
      return next
    })
  }
  const ready = name.trim().length > 0 && members.length >= 2 && confirmed && !!coordinatorBotId
  const create = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await window.bot.team({
        method: 'team.create',
        params: {
          idempotencyKey: crypto.randomUUID(),
          name: name.trim(),
          objective: objective.trim(),
          confirmSharing: true,
          members: members.map((member) => ({ botId: member.botId, role: member.role.trim(), coordinator: member.botId === coordinatorBotId })),
        },
      })
      onCreated(result.team.id)
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  if (available.length < 2)
    return (
      <section className="empty">
        <h1>{t('newTeam')}</h1>
        <p>{t('teamNeedsTwoBots')}</p>
        <Button onClick={onCancel}>{t('back')}</Button>
      </section>
    )
  return (
    <section className="team-create">
      <h1>{t('newTeam')}</h1>
      <label>
        <span>{t('teamName')}</span>
        <Input value={name} placeholder={t('teamNamePlaceholder')} autoFocus onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>{t('teamObjective')}</span>
        <Textarea value={objective} placeholder={t('teamObjectivePlaceholder')} rows={2} onChange={(event) => setObjective(event.target.value)} />
      </label>
      <fieldset>
        <legend>{t('teamMembers')}</legend>
        <p className="hint">{t('teamMembersHint')}</p>
        <ul className="team-member-picker">
          {available.map((bot) => {
            const member = members.find((entry) => entry.botId === bot.id)
            return (
              <li key={bot.id}>
                <label>
                  <input type="checkbox" checked={!!member} onChange={() => toggle(bot.id)} />
                  <span className="avatar" aria-hidden="true">
                    {bot.name.slice(0, 1).toUpperCase()}
                  </span>
                  <strong>{bot.name}</strong>
                </label>
                {member && (
                  <Input
                    aria-label={`${t('teamRolePlaceholder')} — ${bot.name}`}
                    placeholder={t('teamRolePlaceholder')}
                    value={member.role}
                    onChange={(event) =>
                      setMembers((current) => current.map((entry) => (entry.botId === bot.id ? { ...entry, role: event.target.value } : entry)))
                    }
                  />
                )}
              </li>
            )
          })}
        </ul>
      </fieldset>
      <fieldset>
        <legend>{t('teamCoordinator')}</legend>
        <p className="hint">{t('teamCoordinatorHint')}</p>
        {members.map((member) => {
          const bot = available.find((entry) => entry.id === member.botId)!
          return (
            <label key={member.botId} className="team-coordinator-option">
              <input type="radio" name="coordinator" checked={coordinatorBotId === member.botId} onChange={() => setCoordinatorBotId(member.botId)} />
              <span>{bot.name}</span>
            </label>
          )
        })}
      </fieldset>
      <section className="team-sharing" aria-labelledby="team-sharing-title">
        <h2 id="team-sharing-title">{t('teamSharing')}</h2>
        <p>{t('teamSharingText')}</p>
        {/* The boundary is stated honestly: separate threads are not isolation inside one bot. */}
        <p className="caution">{t('teamSharingCaution')}</p>
        <label className="team-sharing-confirm">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>{t('teamSharingConfirm')}</span>
        </label>
      </section>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      <div className="team-create-actions">
        <Button onClick={onCancel}>{t('cancel')}</Button>
        <Button className="primary" disabled={!ready || busy} onClick={() => void create()}>
          {t('createTeam')}
        </Button>
      </div>
    </section>
  )
}
