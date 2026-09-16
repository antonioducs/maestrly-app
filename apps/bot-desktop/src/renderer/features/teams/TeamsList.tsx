import { Plus, Users } from 'lucide-react'
import type { Team } from '@maestrly/host-protocol'
import { Button } from '../../ui'
import { useT } from '../../i18n'

/**
 * A compact Teams section in the sidebar. Bots stay exactly where they were: for someone
 * who uses a single bot, nothing in the main flow changes.
 */
export function TeamsList({
  teams,
  selectedId,
  disabled,
  onSelect,
  onCreate,
}: {
  teams: Team[]
  selectedId?: string
  disabled: boolean
  onSelect: (team: Team) => void
  onCreate: () => void
}) {
  const t = useT()
  return (
    <>
      <div className="sidebar-label">{t('teams')}</div>
      <nav aria-label={t('teams')}>
        {teams.map((team) => (
          <Button key={team.id} className={team.id === selectedId ? 'selected' : ''} aria-label={team.name} onClick={() => onSelect(team)}>
            <span className="avatar team" aria-hidden="true">
              <Users size={14} />
            </span>
            <span className="bot-label">
              <strong>{team.name}</strong>
              <small>{team.objective || `${t('teamParticipants')}`}</small>
            </span>
          </Button>
        ))}
        <Button disabled={disabled} className="new-bot" aria-label={t('newTeam')} onClick={onCreate}>
          <Plus size={16} aria-hidden="true" />
          <span className="bot-label">{t('newTeam')}</span>
        </Button>
      </nav>
    </>
  )
}
