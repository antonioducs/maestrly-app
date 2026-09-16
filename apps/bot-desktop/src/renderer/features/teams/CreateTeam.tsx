import { useState } from 'react'
import { Eye } from 'lucide-react'
import type { Bot } from '@maestrly/host-protocol'
import { Button, Input, Textarea } from '../../ui'
import { useT } from '../../i18n'

type Draft = { botId: string; role: string }
/**
 * Creating a team asks only what a person can answer: a name, which bots take part and who
 * organises the work. It never asks about computers, sessions, resources or protocol, and
 * it never creates a bot or a VM — it links bots that already exist.
 *
 * Each bot is one row: choosing it, naming its role and marking who organises happen in place,
 * so the roster is read once instead of being repeated in a second list further down.
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
  // A disabled button explains itself instead of leaving the person guessing what is missing.
  const missing = !name.trim() ? 'teamMissingName' : members.length < 2 ? 'teamMissingMembers' : !confirmed ? 'teamMissingConsent' : undefined
  const ready = !missing && !!coordinatorBotId
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
      <header className="team-create-head">
        <h1>{t('newTeam')}</h1>
        <p>{t('teamCreateSubtitle')}</p>
      </header>
      {/* A real form, so Enter on the name field creates the team instead of doing nothing. */}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <div className="team-create-body">
          <label className="team-field">
            <span>{t('teamName')}</span>
            <Input value={name} placeholder={t('teamNamePlaceholder')} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="team-field">
            <span>{t('teamObjective')}</span>
            <Textarea value={objective} placeholder={t('teamObjectivePlaceholder')} rows={2} onChange={(event) => setObjective(event.target.value)} />
          </label>
          <section className="team-create-section" aria-labelledby="team-members-title">
            <h2 id="team-members-title">{t('teamMembers')}</h2>
            <p className="hint">{t('teamCoordinatorHint')}</p>
            <ul className="team-picker">
              {available.map((bot) => {
                const member = members.find((entry) => entry.botId === bot.id)
                const organises = coordinatorBotId === bot.id
                return (
                  <li key={bot.id} className={member ? (organises ? 'chosen organises' : 'chosen') : undefined}>
                    <label className="team-pick">
                      <input type="checkbox" checked={!!member} onChange={() => toggle(bot.id)} />
                      <span className="avatar" aria-hidden="true">
                        {bot.name.slice(0, 1).toUpperCase()}
                      </span>
                      <strong title={bot.name}>{bot.name}</strong>
                    </label>
                    {member && (
                      <>
                        <Input
                          className="team-role"
                          aria-label={`${t('teamRolePlaceholder')} — ${bot.name}`}
                          placeholder={t('teamRolePlaceholder')}
                          maxLength={60}
                          value={member.role}
                          onChange={(event) =>
                            setMembers((current) => current.map((entry) => (entry.botId === bot.id ? { ...entry, role: event.target.value } : entry)))
                          }
                        />
                        {/* Who organises is decided on the bot's own row, not in a second list of the same names. */}
                        <label className="team-lead">
                          <input
                            type="radio"
                            name="coordinator"
                            checked={organises}
                            aria-label={`${bot.name} — ${t('teamOrganisesAria')}`}
                            onChange={() => setCoordinatorBotId(bot.id)}
                          />
                          <span>{t('teamOrganises')}</span>
                        </label>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
          <section className="team-sharing" aria-labelledby="team-sharing-title">
            <h2 id="team-sharing-title">
              <Eye size={14} aria-hidden="true" />
              {t('teamSharing')}
            </h2>
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
        </div>
        <footer className="team-create-actions">
          <p className="team-create-status" role="status">
            {missing ? t(missing) : ''}
          </p>
          <Button type="button" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button className="primary" type="submit" disabled={!ready || busy}>
            {t(busy ? 'teamCreating' : 'createTeam')}
          </Button>
        </footer>
      </form>
    </section>
  )
}
