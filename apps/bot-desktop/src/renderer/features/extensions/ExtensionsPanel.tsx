import { useT } from '../../i18n'
import { McpSettings } from './McpSettings'
import { SkillsSettings } from './SkillsSettings'
import { useExtensions } from './useExtensions'

/** The extensions tab of a bot: MCP servers and skills, on a Host that knows the chat experience. */
export function ExtensionsPanel({ botId, connected, supported }: { botId: string; connected: boolean; supported: boolean }) {
  const t = useT()
  const extensions = useExtensions(botId, connected, supported)
  if (connected && !supported) return <p role="status">{t('extensionsHostOutdated')}</p>
  return (
    <div className="extensions-panel">
      {!connected && <p>{t('connectionReason')}</p>}
      <McpSettings extensions={extensions} connected={connected} />
      <SkillsSettings extensions={extensions} connected={connected} />
      {extensions.error && <p role="alert">{extensions.error}</p>}
    </div>
  )
}
