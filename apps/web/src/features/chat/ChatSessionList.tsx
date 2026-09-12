import type { ProjectChatSession } from '@maestrly/protocol'
import { MessageSquare, Plus } from 'lucide-react'
import { t } from '../../i18n/index.js'
export function ChatSessionList({
  sessions,
  selected,
  onSelect,
  onNew,
  more,
  onMore,
}: {
  sessions: ProjectChatSession[]
  selected: string
  onSelect(id: string): void
  onNew(): void
  more: boolean
  onMore(): void
}) {
  return (
    <nav className="project-chat-history" aria-label={t('Chat history')}>
      <button className="quiet" onClick={onNew}>
        <Plus size={14} />
        {t('New conversation')}
      </button>
      {sessions.map((s) => (
        <button key={s.id} aria-current={selected === s.id ? 'page' : undefined} onClick={() => onSelect(s.id)}>
          <MessageSquare size={14} />
          <span>{s.title}</span>
        </button>
      ))}
      {more ? (
        <button className="quiet" onClick={onMore}>
          {t('Load more')}
        </button>
      ) : null}
    </nav>
  )
}
