import type { TFunction } from 'i18next'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  type PluginHookDto,
  type PluginInputDto,
  type PluginMarketplaceDto,
  type PluginOpErrorCode,
  type PluginReason,
  pluginTokenInputId,
} from '../../../shared/plugins'

export const inputCls =
  'w-full rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-indigo-500/60'

export function Toggle({
  on,
  onClick,
  label,
  disabled,
}: {
  on: boolean
  onClick: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-50',
        on ? 'bg-emerald-500/70' : 'bg-white/10'
      )}
    >
      <span className={cn('block h-3 w-3 rounded-full bg-white transition-transform', on && 'translate-x-3')} />
    </button>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>
}

/** Localized explanation of one compatibility reason. */
export function reasonText(t: TFunction, reason: PluginReason): string {
  const subject =
    reason.subject ?? (reason.component ? t(`component.kind.${reason.component}`, { ns: 'plugins' }) : '') ?? ''
  return t(`compat.reason.${reason.code}`, { ns: 'plugins', subject })
}

/** Localized error of a plugin operation (unknown codes fall back to the generic install failure). */
export function errorText(t: TFunction, error: PluginOpErrorCode | string | undefined): string {
  return t(`errors.${error ?? 'install-failed'}`, {
    ns: 'plugins',
    defaultValue: t('errors.install-failed', { ns: 'plugins' }),
  })
}

/** How a setting a plugin asks for is shown; the access token Maestrly asks for itself is named in the app's language. */
export function inputText(
  t: TFunction,
  input: Pick<PluginInputDto, 'id' | 'label' | 'description' | 'serverKey'>
): { label: string; description: string | null } {
  if (input.serverKey && input.id === pluginTokenInputId(input.serverKey))
    return {
      label: t('install.accessToken', { ns: 'plugins', server: input.serverKey }),
      description: t('install.accessTokenHint', { ns: 'plugins' }),
    }
  return { label: input.label, description: input.description }
}

export const shortCommit = (commit: string | null | undefined): string => (commit ? commit.slice(0, 7) : '')

/** Initials of a plugin name, shown when it has no logo. */
export function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : name.slice(0, 2)).toUpperCase()
}

/** A source's name: its own, else `owner/repo` for GitHub, else its URL; never with the `.git` suffix. */
export function marketplaceLabel(marketplace: Pick<PluginMarketplaceDto, 'displayName' | 'name' | 'url'>): string {
  return (
    marketplace.displayName ??
    marketplace.name ??
    marketplace.url.replace(/^https:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')
  )
}

/** A plugin's hooks as the person approves them: event, matcher and the exact command. */
export function HookList({ hooks }: { hooks: readonly PluginHookDto[] }) {
  return (
    <ul className="mt-1 flex flex-col gap-0.5">
      {hooks.map((hook, index) => (
        <li key={`${hook.event}-${index}`} className="font-mono text-[11px] text-muted-foreground">
          {hook.event}
          {hook.matcher ? ` · ${hook.matcher}` : ''} · {hook.command}
        </li>
      ))}
    </ul>
  )
}
