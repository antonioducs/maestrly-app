import { useEffect, useState } from 'react'
import type { BotFile } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import { FileCard } from '../chat/MessageList'
export function BotFiles({ botId, onPreview }: { botId: string; onPreview: (name: string, text: string) => void }) {
  const t = useT()
  const [files, setFiles] = useState<BotFile[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    void window.bot
      .bot({ method: 'bot.files.list', params: { botId } })
      .then(setFiles)
      .catch((error) => setError(String(error)))
  }, [botId])
  return (
    <section>
      {!files.length && <p>{t('noFiles')}</p>}
      {files
        .filter((file) => file.kind === 'file')
        .map((file) => (
          <FileCard key={file.path} botId={botId} file={file} onPreview={onPreview} />
        ))}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
