import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { AlertTriangle, BrainCircuit, Code2, Globe2, MessageSquareText, SlidersHorizontal } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { hasEffectiveChatGptWebMcpWriteAccess } from '@/lib/chatgpt-web'
import { cn } from '@/lib/utils'
import type {
  ChatGptWebBrowserCapability,
  ChatGptWebCapabilities,
  ChatGptWebCapabilitiesInfo,
  ChatGptWebCapabilityScope,
} from '../../../shared/chat'

export interface ChatGptWebAccessEditorProps {
  info: Pick<ChatGptWebCapabilitiesInfo, 'mcpServers'>
  capabilities: ChatGptWebCapabilities
  editable: boolean
  disabled?: boolean
  onChange: (capabilities: ChatGptWebCapabilities) => void
  variant?: 'compact' | 'full'

  showBrowser?: boolean
}

const selectClassName =
  'h-7 w-auto shrink-0 text-[11px]'

export function ChatGptWebAccessEditor({
  info,
  capabilities,
  editable,
  disabled = false,
  onChange,
  variant = 'full',
  showBrowser = true,
}: ChatGptWebAccessEditorProps) {
  const { t } = useTranslation('chat')
  const browserScopeName = useId()
  const conversationScopeName = useId()
  const memoryScopeName = useId()
  const controlsDisabled = disabled || !editable
  const compact = variant === 'compact'

  const setBrowser = (browser: ChatGptWebBrowserCapability) => {
    if (controlsDisabled) return
    onChange({ ...capabilities, browser })
  }

  const setCodeScope = (target: 'git' | 'gh', scope: 'off' | 'read') => {
    if (controlsDisabled) return
    onChange({ ...capabilities, [target]: scope })
  }

  const setConversationScope = (conversation: 'off' | 'read') => {
    if (controlsDisabled) return
    onChange({ ...capabilities, conversation })
  }

  const setMemoryScope = (memory: 'off' | 'read') => {
    if (controlsDisabled) return
    onChange({ ...capabilities, memory })
  }

  const setMcpScope = (id: string, scope: ChatGptWebCapabilityScope) => {
    if (controlsDisabled) return
    onChange({ ...capabilities, mcp: { ...capabilities.mcp, [id]: scope } })
  }

  const browserOptions: Array<{
    value: ChatGptWebBrowserCapability
    label: string
    description: string
  }> = [
    {
      value: 'off',
      label: t('chatGptWebAccess.scopeOff'),
      description: t('chatGptWebAccess.browserOffDescription'),
    },
    {
      value: 'inspect',
      label: t('chatGptWebAccess.scopeInspect'),
      description: t('chatGptWebAccess.browserInspectDescription'),
    },
    {
      value: 'interact',
      label: t('chatGptWebAccess.scopeInteract'),
      description: t('chatGptWebAccess.browserInteractDescription'),
    },
  ]

  return (
    <fieldset disabled={controlsDisabled} className={cn('space-y-3', compact && 'space-y-2.5')}>
      {!editable && (
        <div className="rounded border border-amber-500/25 bg-amber-500/[0.07] px-2 py-1.5 text-[11px] text-amber-200">
          {t('chatGptWebAccess.locked')}
        </div>
      )}

      {showBrowser && (
        <section className="rounded-lg border border-violet-400/20 bg-violet-500/[0.07] p-2.5">
          <div className="flex items-start gap-2">
            <Globe2 className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
            <div>
              <div className="text-[12px] font-medium text-foreground">{t('chatGptWebAccess.browserTitle')}</div>
              <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                {t('chatGptWebAccess.browserDescription')}
              </div>
            </div>
          </div>
          <div className={cn('mt-2 grid gap-1.5', !compact && 'sm:grid-cols-3')}>
            {browserOptions.map((option) => {
              const selected = capabilities.browser === option.value
              return (
                <label
                  key={option.value}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors',
                    selected
                      ? 'border-violet-400/35 bg-violet-400/[0.1]'
                      : 'border-white/[0.07] bg-black/[0.08] hover:bg-white/[0.04]',
                    controlsDisabled && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <input
                    type="radio"
                    name={browserScopeName}
                    value={option.value}
                    checked={selected}
                    onChange={() => setBrowser(option.value)}
                    className="mt-0.5 accent-violet-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-[11px] font-medium text-foreground">{option.label}</span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          <div className="mt-2 text-[10px] leading-relaxed text-violet-100/75">
            {t('chatGptWebAccess.browserIsolation')}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-cyan-400/20 bg-cyan-500/[0.05] p-2.5">
        <div className="flex items-start gap-2">
          <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
          <div>
            <div className="text-[12px] font-medium text-foreground">{t('chatGptWebAccess.conversationTitle')}</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              {t('chatGptWebAccess.conversationDescription')}
            </div>
          </div>
        </div>
        <div className={cn('mt-2 grid gap-1.5', !compact && 'sm:grid-cols-2')}>
          {(['off', 'read'] as const).map((scope) => (
            <label
              key={scope}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors',
                capabilities.conversation === scope
                  ? 'border-cyan-400/35 bg-cyan-400/[0.1]'
                  : 'border-white/[0.07] bg-black/[0.08] hover:bg-white/[0.04]',
                controlsDisabled && 'cursor-not-allowed opacity-60'
              )}
            >
              <input
                type="radio"
                name={conversationScopeName}
                value={scope}
                checked={capabilities.conversation === scope}
                onChange={() => setConversationScope(scope)}
                className="mt-0.5 accent-cyan-500"
              />
              <span className="min-w-0">
                <span className="block text-[11px] font-medium text-foreground">
                  {t(`chatGptWebAccess.scope${scope === 'off' ? 'Off' : 'Read'}`)}
                </span>
                <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                  {t(`chatGptWebAccess.conversation${scope === 'off' ? 'Off' : 'Read'}Description`)}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-2 text-[10px] leading-relaxed text-cyan-100/75">
          {t('chatGptWebAccess.conversationIsolation')}
        </div>
      </section>

      <section className="rounded-lg border border-fuchsia-400/20 bg-fuchsia-500/[0.05] p-2.5">
        <div className="flex items-start gap-2">
          <BrainCircuit className="mt-0.5 h-4 w-4 shrink-0 text-fuchsia-300" />
          <div>
            <div className="text-[12px] font-medium text-foreground">{t('chatGptWebAccess.memoryTitle')}</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              {t('chatGptWebAccess.memoryDescription')}
            </div>
          </div>
        </div>
        <div className={cn('mt-2 grid gap-1.5', !compact && 'sm:grid-cols-2')}>
          {(['off', 'read'] as const).map((scope) => (
            <label
              key={scope}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors',
                capabilities.memory === scope
                  ? 'border-fuchsia-400/35 bg-fuchsia-400/[0.1]'
                  : 'border-white/[0.07] bg-black/[0.08] hover:bg-white/[0.04]',
                controlsDisabled && 'cursor-not-allowed opacity-60'
              )}
            >
              <input
                type="radio"
                name={memoryScopeName}
                value={scope}
                checked={capabilities.memory === scope}
                onChange={() => setMemoryScope(scope)}
                className="mt-0.5 accent-fuchsia-500"
              />
              <span className="min-w-0">
                <span className="block text-[11px] font-medium text-foreground">
                  {t(`chatGptWebAccess.scope${scope === 'off' ? 'Off' : 'Read'}`)}
                </span>
                <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                  {t(`chatGptWebAccess.memory${scope === 'off' ? 'Off' : 'Read'}Description`)}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-2 text-[10px] leading-relaxed text-fuchsia-100/75">
          {t('chatGptWebAccess.memoryIsolation')}
        </div>
      </section>

      <section className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-2.5">
        <div className="flex items-start gap-2">
          <Code2 className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" />
          <div>
            <div className="text-[12px] font-medium text-foreground">{t('chatGptWebAccess.codeTitle')}</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              {t('chatGptWebAccess.codeDescription')}
            </div>
          </div>
        </div>
        <div className="mt-1.5 space-y-1">
          {(['git', 'gh'] as const).map((target) => (
            <label
              key={target}
              className="flex items-center justify-between gap-3 rounded px-1.5 py-1.5 text-[12px] text-foreground"
            >
              <span className="min-w-0">
                <span>{t(`chatGptWebAccess.${target}Label`)}</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                  {t(`chatGptWebAccess.${target}Description`)}
                </span>
              </span>
              <OptionSelect
                aria-label={t(`chatGptWebAccess.${target}Label`)}
                value={capabilities[target]}
                onValueChange={(selectedValue) => setCodeScope(target, selectedValue as 'off' | 'read')}
                className={selectClassName}
              >
                <SelectOption value="off">{t('chatGptWebAccess.scopeOff')}</SelectOption>
                <SelectOption value="read">{t('chatGptWebAccess.scopeRead')}</SelectOption>
              </OptionSelect>
            </label>
          ))}
        </div>
        {capabilities.gh === 'read' && (
          <div className="mt-1 rounded bg-amber-500/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-amber-100/80">
            {t('chatGptWebAccess.ghGlobalWarning')}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-2.5">
        <div className="flex items-start gap-2">
          <SlidersHorizontal className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="text-[12px] font-medium text-foreground">{t('chatGptWebAccess.advancedTitle')}</div>
            <div className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
              {t('chatGptWebAccess.mcpDescription')}
            </div>
          </div>
        </div>
        {info.mcpServers.length === 0 ? (
          <div className="mt-2 rounded bg-white/[0.03] px-2 py-1.5 text-[10px] text-muted-foreground">
            {t('chatGptWebAccess.mcpEmpty')}
          </div>
        ) : (
          <div className="mt-1.5 space-y-1">
            {info.mcpServers.map((server) => (
              <label
                key={server.id}
                className="flex items-center justify-between gap-3 rounded px-1.5 py-1.5 text-[12px] text-foreground"
              >
                <span className="min-w-0">
                  <span className="block truncate">{server.name}</span>
                  {!server.enabled && (
                    <span className="mt-0.5 block text-[10px] leading-snug text-amber-400/80">
                      {t('chatGptWebAccess.mcpDisabledGlobally')}
                    </span>
                  )}
                </span>
                <OptionSelect
                  aria-label={server.name}
                  value={server.enabled ? (capabilities.mcp[server.id] ?? 'read') : 'off'}
                  disabled={controlsDisabled || !server.enabled}
                  onValueChange={(selectedValue) => setMcpScope(server.id, selectedValue as ChatGptWebCapabilityScope)}
                  className={selectClassName}
                >
                  <SelectOption value="off">{t('chatGptWebAccess.scopeOff')}</SelectOption>
                  <SelectOption value="read">{t('chatGptWebAccess.scopeRead')}</SelectOption>
                  <SelectOption value="write">{t('chatGptWebAccess.scopeWrite')}</SelectOption>
                </OptionSelect>
              </label>
            ))}
          </div>
        )}
        {hasEffectiveChatGptWebMcpWriteAccess(info, capabilities) && (
          <div className="mt-2 flex items-start gap-1.5 rounded bg-amber-500/[0.07] px-2 py-1.5 text-[10px] leading-relaxed text-amber-100/80">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{t('chatGptWebAccess.mcpWriteRisk')}</span>
          </div>
        )}
      </section>
    </fieldset>
  )
}
