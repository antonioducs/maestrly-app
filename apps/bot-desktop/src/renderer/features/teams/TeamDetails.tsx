import { useEffect, useState } from 'react'
import { TEAM_LIMITS, type Bot, type TeamArtifact, type TeamDetails as Details, type TeamMemory } from '@maestrly/host-protocol'
import { Button, Input, Select } from '../../ui'
import { useT } from '../../i18n'
import { RoutinePanel } from '../routines/RoutinePanel'

/**
 * Everything about a team a person may need, grouped and calm: who takes part, which files
 * are shared, what the team remembers and — under Advanced — the limits this Host applies.
 * No dashboard, no metrics, no identifiers.
 */
export function TeamDetails({
  details,
  bots,
  advanced,
  connected,
  routinesSupported = false,
  onChanged,
  onArchived,
}: {
  details: Details
  bots: Bot[]
  advanced: boolean
  connected: boolean
  /** False on a Host that predates routines; the section explains instead of failing. */
  routinesSupported?: boolean
  onChanged: (details: Details) => void
  onArchived: () => void
}) {
  const t = useT()
  const [artifacts, setArtifacts] = useState<TeamArtifact[]>([])
  const [memories, setMemories] = useState<TeamMemory[]>([])
  const [proposals, setProposals] = useState<TeamMemory[]>([])
  const [note, setNote] = useState('')
  const [members, setMembers] = useState(details.members.map((member) => ({ botId: member.botId, role: member.role, coordinator: member.coordinator })))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const teamId = details.team.id
  const nameOf = (botId: string) => bots.find((bot) => bot.id === botId)?.name ?? botId.slice(0, 6)
  const load = async () => {
    const [files, notes, pending] = await Promise.all([
      window.bot.team({ method: 'team.artifacts.list', params: { teamId, includeRevoked: false } }),
      window.bot.team({ method: 'team.memory.list', params: { teamId, includeInactive: false } }),
      window.bot.team({ method: 'team.memory.proposals', params: { teamId } }),
    ])
    setArtifacts(files)
    setMemories(notes)
    setProposals(pending)
  }
  useEffect(() => {
    if (connected) void load().catch((error) => setError(String(error)))
  }, [teamId, connected])
  const guard = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }
  const saveMembers = () =>
    guard(async () => {
      const current = await window.bot.team({ method: 'team.inspect', params: { teamId } })
      const updated = await window.bot.team({
        method: 'team.members.set',
        params: {
          teamId,
          expectedRevision: current.team.revision,
          idempotencyKey: crypto.randomUUID(),
          confirmSharing: true,
          members: members.map((member) => ({ botId: member.botId, role: member.role, coordinator: member.coordinator })),
        },
      })
      onChanged(updated)
    })
  const archive = () =>
    guard(async () => {
      const current = await window.bot.team({ method: 'team.inspect', params: { teamId } })
      await window.bot.team({ method: 'team.archive', params: { teamId, expectedRevision: current.team.revision, idempotencyKey: crypto.randomUUID() } })
      onArchived()
    })
  const used = details.activeRun?.budget
  return (
    <div className="team-details">
      <section>
        <h3>{t('teamParticipants')}</h3>
        <ul className="team-members">
          {members.map((member) => (
            <li key={member.botId}>
              <span className="avatar" aria-hidden="true">
                {nameOf(member.botId).slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{nameOf(member.botId)}</strong>
                <Input
                  aria-label={`${t('teamRolePlaceholder')} — ${nameOf(member.botId)}`}
                  placeholder={t('teamRolePlaceholder')}
                  value={member.role}
                  onChange={(event) => setMembers((current) => current.map((entry) => (entry.botId === member.botId ? { ...entry, role: event.target.value } : entry)))}
                />
              </div>
              <label className="team-lead">
                <input
                  type="radio"
                  name="team-coordinator"
                  checked={member.coordinator}
                  aria-label={`${nameOf(member.botId)} — ${t('teamOrganisesAria')}`}
                  onChange={() => setMembers((current) => current.map((entry) => ({ ...entry, coordinator: entry.botId === member.botId })))}
                />
                <span>{t('teamOrganises')}</span>
              </label>
              {members.length > 2 && (
                <Button aria-label={`${t('teamRemoveMember')} ${nameOf(member.botId)}`} onClick={() => setMembers((current) => current.filter((entry) => entry.botId !== member.botId))}>
                  ×
                </Button>
              )}
            </li>
          ))}
        </ul>
        {/* Adding a bot is explained, not just a checkbox: it changes what that bot sees. */}
        <p className="hint">{t('teamMemberScope')}</p>
        {/* The same menu primitive the rest of the app uses, instead of a raw platform control. */}
        <Select
          aria-label={t('teamAddMember')}
          value=""
          onValueChange={(value) => {
            if (value) setMembers((current) => [...current, { botId: value, role: '', coordinator: false }])
          }}
        >
          <option value="">{t('teamAddMember')}</option>
          {bots
            .filter((bot) => bot.status === 'ready' && !members.some((member) => member.botId === bot.id))
            .map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
        </Select>
        <Button disabled={busy || !connected || members.length < 2} onClick={() => void saveMembers()}>
          {t('teamSaveMembers')}
        </Button>
        {details.activeRun && <p className="hint">{t('teamWorkInProgress')}</p>}
      </section>
      <section>
        <h3>{t('teamFiles')}</h3>
        {!artifacts.length && <p className="hint">{t('teamNoFiles')}</p>}
        <ul className="team-files">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <div>
                <strong>{artifact.name}</strong>
                {/* Where a file came from is always visible. */}
                <small>{artifact.origin.kind === 'human' ? t('yourRequest') : nameOf(artifact.origin.botId)}</small>
              </div>
              <Button
                disabled={busy || !connected}
                onClick={() =>
                  void guard(async () => {
                    await window.bot.team({ method: 'team.artifacts.revoke', params: { teamId, artifactId: artifact.id, idempotencyKey: crypto.randomUUID() } })
                    await load()
                  })
                }
              >
                {t('teamRevoke')}
              </Button>
            </li>
          ))}
        </ul>
        {!!artifacts.length && <p className="hint">{t('teamRevokedNotice')}</p>}
      </section>
      <section>
        <h3>{t('teamMemory')}</h3>
        {!memories.length && !proposals.length && <p className="hint">{t('teamNoMemory')}</p>}
        <ul className="team-memory">
          {proposals.map((memory) => (
            <li key={memory.id} className="proposed">
              <div>
                <small>{t('teamMemoryProposed')}</small>
                <p>{memory.content}</p>
              </div>
              {/* A bot proposal needs an explicit decision before it counts as memory. */}
              <Button
                disabled={busy || !connected}
                onClick={() =>
                  void guard(async () => {
                    await window.bot.team({ method: 'team.memory.decide', params: { teamId, memoryId: memory.id, expectedRevision: memory.revision, decision: 'approve' } })
                    await load()
                  })
                }
              >
                {t('teamApprove')}
              </Button>
              <Button
                disabled={busy || !connected}
                onClick={() =>
                  void guard(async () => {
                    await window.bot.team({ method: 'team.memory.decide', params: { teamId, memoryId: memory.id, expectedRevision: memory.revision, decision: 'discard' } })
                    await load()
                  })
                }
              >
                {t('teamDiscard')}
              </Button>
            </li>
          ))}
          {memories.map((memory) => (
            <li key={memory.id}>
              <p>{memory.content}</p>
              <Button
                disabled={busy || !connected}
                onClick={() =>
                  void guard(async () => {
                    await window.bot.team({ method: 'team.memory.remove', params: { teamId, memoryId: memory.id, expectedRevision: memory.revision } })
                    await load()
                  })
                }
              >
                {t('remove')}
              </Button>
            </li>
          ))}
        </ul>
        <Input aria-label={t('teamAddMemory')} value={note} placeholder={t('teamAddMemory')} onChange={(event) => setNote(event.target.value)} />
        <Button
          disabled={busy || !connected || !note.trim()}
          onClick={() =>
            void guard(async () => {
              await window.bot.team({ method: 'team.memory.upsert', params: { teamId, content: note.trim() } })
              setNote('')
              await load()
            })
          }
        >
          {t('teamAddMemory')}
        </Button>
        <p className="hint">{t('teamMemoryHint')}</p>
      </section>
      {advanced && (
        <section>
          <h3>{t('teamAdvanced')}</h3>
          <p className="hint">{t('teamAdvancedText')}</p>
          <dl className="team-limits">
            <dt>{t('teamLimitMembers')}</dt>
            <dd>{TEAM_LIMITS.membersMax}</dd>
            <dt>{t('teamLimitConcurrency')}</dt>
            <dd>{details.team.policy.concurrency}</dd>
            <dt>{t('teamLimitRounds')}</dt>
            <dd>{details.team.policy.maxRounds}</dd>
            <dt>{t('teamLimitTasks')}</dt>
            <dd>{details.team.policy.maxTasks}</dd>
            <dt>{t('teamLimitTurns')}</dt>
            <dd>{details.team.policy.maxTurns}</dd>
            <dt>{t('teamLimitTools')}</dt>
            <dd>{details.team.policy.maxToolCalls}</dd>
            <dt>{t('teamLimitTime')}</dt>
            <dd>{Math.round(details.team.policy.maxActiveMs / 60_000)} min</dd>
          </dl>
          {used && (
            <p className="hint">
              {t('teamBudgetUsed')}: {used.turns}/{details.team.policy.maxTurns} · {used.toolCallsSettled}/{details.team.policy.maxToolCalls}
              {/* Unknown consumption is reported as unknown, never as zero. */}
              {!used.tokensObserved && <> · {t('teamTokensUnknown')}</>}
            </p>
          )}
        </section>
      )}
      <section>
        <h3>{t('routines')}</h3>
        <RoutinePanel
          target={{ kind: 'team', id: details.team.id }}
          targetName={details.team.name}
          connected={connected}
          supported={routinesSupported}
        />
      </section>
      <section>
        <h3>{t('teamArchive')}</h3>
        <p className="hint">{t('teamArchiveHint')}</p>
        <Button disabled={busy || !connected} onClick={() => void archive()}>
          {t('teamArchive')}
        </Button>
      </section>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  )
}
