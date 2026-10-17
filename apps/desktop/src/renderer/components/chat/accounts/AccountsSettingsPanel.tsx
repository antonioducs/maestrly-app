import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Repeat, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatConfig, ChatSubscriptionProviderKind } from '../../../../shared/chat'
import { subscriptionUsageResetDisplay } from '../subscription-usage-presentation'
import { ChatGptWebSettings, useChatGptWebPhaseLabel } from '../ChatGptWebSettings'
import {
  type AccountEntry,
  type AccountFilter,
  type AccountGroup,
  type AccountSnapshot,
  type AccountSummary,
  type ChatGptWebAccountSnapshot,
  type SubscriptionAccountEntry,
  type SubscriptionAccountSnapshot,
  accountGroups,
  accountSummary,
  baseUrlHost,
  CHATGPT_WEB_ENTRY_KEY,
  chatGptWebPhase,
  connectableGroups,
  hasActiveRotation,
  isAccountListed,
  matchesAccountFilter,
  needsAttention,
  runtimeMissing,
} from './account-entries'
import { inputCls, primaryButtonCls, ProviderMark, type ProviderMarkKind, UsageGauge } from './account-ui'
import { AddAccountDialog, type AddAccountIntent } from './AddAccountDialog'
import { ApiKeyAccount, kindLabelKey } from './ApiKeyAccount'
import { SubscriptionAccount, subscriptionProviderCopy, useSubscriptionAccountTitle } from './SubscriptionAccount'

interface Row {
  entry: AccountEntry
  group: AccountGroup
  summary: AccountSummary
  title: string
  meta: string
  metaTone: 'muted' | 'warn' | 'bad'
  rotation: boolean
}

const FILTERS: AccountFilter[] = ['all', 'attention', 'near-limit']

function markKind(entry: AccountEntry): ProviderMarkKind {
  if (entry.type === 'subscription') return entry.providerKind
  if (entry.type === 'chatgpt-web') return 'chatgpt-web'
  return { apiName: entry.provider.name, baseURL: entry.provider.baseURL }
}

export function AccountsSettingsPanel({
  config,
  onChanged,
  onModelFilterChanged,
}: {
  config: ChatConfig
  onChanged: () => void
  onModelFilterChanged: () => void
}) {
  const { t, i18n } = useTranslation('chat')
  const subscriptionTitle = useSubscriptionAccountTitle()
  const chatGptWebLabel = useChatGptWebPhaseLabel()
  const groups = useMemo(() => accountGroups(config), [config])
  const [snapshots, setSnapshots] = useState<Record<string, AccountSnapshot>>({})
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  const [filter, setFilter] = useState<AccountFilter>('all')
  const [query, setQuery] = useState('')
  const [addIntent, setAddIntent] = useState<AddAccountIntent | null>(null)
  const [pendingLogin, setPendingLogin] = useState<string | null>(null)
  const [pendingSelection, setPendingSelection] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const reportSnapshot = useCallback((key: string, snapshot: AccountSnapshot | null) => {
    setSnapshots((current) => {
      if (snapshot === null) {
        if (!(key in current)) return current
        const { [key]: _removed, ...rest } = current
        return rest
      }
      return { ...current, [key]: snapshot }
    })
  }, [])

  const groupName = (group: AccountGroup): string =>
    group.id === 'api-keys' ? t('settings.accountsApiKeysGroup') : t(`settings.accountProviderName_${group.id}`)

  const subscriptionMeta = (
    entry: SubscriptionAccountEntry,
    snapshot: SubscriptionAccountSnapshot | undefined,
    summary: AccountSummary
  ): Pick<Row, 'meta' | 'metaTone'> => {
    const copyKey = (suffix: string) => `settings.${subscriptionProviderCopy[entry.providerKind].prefix}${suffix}`
    const status = snapshot?.status
    if (!status) {
      return { meta: entry.provider?.connected ? t(copyKey('Connected')) : t('settings.loading'), metaTone: 'muted' }
    }
    if (status.state === 'signed-in') {
      if (summary.limitReached && snapshot?.usage?.state === 'ready') {
        const window = snapshot.usage.windows.find((candidate) => candidate.usedPercent >= 100)
        const reset = subscriptionUsageResetDisplay(window?.resetsAt ?? null, i18n.resolvedLanguage || i18n.language)
        return {
          meta:
            reset.kind === 'relative'
              ? t('settings.accountLimitReachedIn', { time: reset.value })
              : reset.kind === 'absolute'
                ? t('settings.accountLimitReachedAt', { time: reset.value })
                : t('settings.accountLimitReached'),
          metaTone: 'bad',
        }
      }
      const facts = [status.username ?? status.email, status.planType].filter(Boolean).join(' · ')
      return { meta: facts || t(copyKey('Connected')), metaTone: 'muted' }
    }
    if (status.state === 'signing-in') return { meta: t(copyKey('WaitingShort')), metaTone: 'warn' }
    if (status.state === 'error') {
      return {
        meta:
          status.errorCode === 'claude-authentication-required'
            ? t('messages.claudeAuthenticationRequired')
            : status.error || t(copyKey('Disconnected')),
        metaTone: 'bad',
      }
    }
    if (status.state === 'unavailable') {
      return status.errorCode === 'subscription-provider-not-configured'
        ? { meta: t('settings.subscriptionNotConfiguredShort'), metaTone: 'bad' }
        : { meta: t(copyKey('Unavailable')), metaTone: 'muted' }
    }
    if (runtimeMissing(snapshot?.runtime) && snapshot?.runtime) {
      return {
        meta: t('settings.componentRequired', { name: t(`settings.componentName_${snapshot.runtime.id}`) }),
        metaTone: entry.accountId ? 'warn' : 'muted',
      }
    }
    return { meta: t(copyKey('Disconnected')), metaTone: entry.accountId ? 'warn' : 'muted' }
  }

  const rowFor = (entry: AccountEntry, group: AccountGroup, summary: AccountSummary): Row => {
    if (entry.type === 'subscription') {
      return {
        entry,
        group,
        summary,
        title: subscriptionTitle(entry),
        rotation: hasActiveRotation(config.subscriptionFailover.routes, entry.key),
        ...subscriptionMeta(entry, snapshots[entry.key] as SubscriptionAccountSnapshot | undefined, summary),
      }
    }
    if (entry.type === 'chatgpt-web') {
      const snapshot = snapshots[entry.key] as ChatGptWebAccountSnapshot | undefined
      const phase = chatGptWebPhase(snapshot)
      const active = snapshot?.status?.sessions.filter((session) => session.state !== 'ended').length ?? 0
      return {
        entry,
        group,
        summary,
        title: t('settings.chatgptWebAccountLabel'),
        meta: chatGptWebLabel(phase, active),
        metaTone: phase === 'error' ? 'bad' : summary.health === 'attention' ? 'warn' : 'muted',
        rotation: false,
      }
    }
    return {
      entry,
      group,
      summary,
      title: entry.provider.name,
      meta: summary.connected ? baseUrlHost(entry.provider.baseURL) : t('settings.accountNoApiKey'),
      metaTone: summary.connected ? 'muted' : 'warn',
      rotation: false,
    }
  }

  const searchText = (row: Row): string => {
    const parts = [row.title, row.meta, groupName(row.group)]
    if (row.entry.type === 'subscription') {
      const status = (snapshots[row.entry.key] as SubscriptionAccountSnapshot | undefined)?.status
      parts.push(
        t(`settings.${subscriptionProviderCopy[row.entry.providerKind].prefix}Heading`),
        status?.email ?? '',
        status?.username ?? '',
        status?.planType ?? ''
      )
    } else if (row.entry.type === 'chatgpt-web') {
      parts.push(t('settings.chatgptWebHeading'))
    } else {
      parts.push(row.entry.provider.baseURL, t(kindLabelKey[row.entry.provider.kind ?? 'openai']))
    }
    return parts.join(' ')
  }

  const allEntries = groups.flatMap((group) => group.entries.map((entry) => ({ entry, group })))
  const summaries = new Map(allEntries.map(({ entry }) => [entry.key, accountSummary(entry, snapshots[entry.key])]))
  const chatGptWebEnabled = (snapshots[CHATGPT_WEB_ENTRY_KEY] as ChatGptWebAccountSnapshot | undefined)?.status?.enabled
  const explicitKey = selectedKey && summaries.has(selectedKey) ? selectedKey : null
  const listed = (entry: AccountEntry, group: AccountGroup) =>
    isAccountListed(entry, summaries.get(entry.key)!, {
      selected: entry.key === explicitKey,
      group,
      chatGptWebEnabled: chatGptWebEnabled === true,
    })

  const browsing = filter === 'all' && !query.trim()
  const rows: Row[] = []
  for (const { entry, group } of allEntries) {
    // A search also finds providers that are not connected yet, so they can be opened from here.
    if (!listed(entry, group) && browsing) continue
    if (!listed(entry, group) && filter !== 'all') continue
    const row = rowFor(entry, group, summaries.get(entry.key)!)
    if (!browsing && !matchesAccountFilter(row.summary, filter, searchText(row), query)) continue
    rows.push(row)
  }
  const listedCount = allEntries.filter(({ entry, group }) => listed(entry, group)).length
  const effectiveKey = explicitKey ?? allEntries.find(({ entry, group }) => listed(entry, group))?.entry.key ?? null
  const chips = browsing ? connectableGroups(groups, listed) : []
  const pendingPresent = pendingSelection !== null && summaries.has(pendingSelection)
  useEffect(() => {
    // An account added from the dialog is selected once the refreshed catalog lists it.
    if (pendingPresent) {
      setSelectedKey(pendingSelection)
      setPendingSelection(null)
      return
    }
    // Pin the automatic choice so signing out of it keeps its row and detail in place.
    if (!explicitKey && effectiveKey && pendingSelection === null) setSelectedKey(effectiveKey)
  }, [explicitKey, effectiveKey, pendingPresent, pendingSelection])

  const summaryValues = [...summaries.values()]
  const connectedCount = summaryValues.filter((summary) => summary.connected).length
  const attentionCount = summaryValues.filter(needsAttention).length
  const nearLimitCount = summaryValues.filter((summary) => summary.nearLimit).length

  const select = (key: string) => {
    setSelectedKey(key)
    setPendingSelection(null)
    setShowDetail(true)
  }
  const selectWhenListed = (key: string) => {
    setPendingSelection(key)
    setShowDetail(true)
  }
  const focusRow = (key: string) => {
    requestAnimationFrame(() =>
      listRef.current?.querySelector<HTMLElement>(`[data-account-entry="${CSS.escape(key)}"]`)?.focus()
    )
  }
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || rows.length === 0) return
    event.preventDefault()
    const index = rows.findIndex((row) => row.entry.key === effectiveKey)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))
    setSelectedKey(rows[next].entry.key)
    focusRow(rows[next].entry.key)
  }
  const clearFilters = () => {
    setFilter('all')
    setQuery('')
  }
  const back = () => setShowDetail(false)
  const showSubscriptionFailover = (kind: ChatSubscriptionProviderKind) =>
    config.subscriptionFailover.supportedKinds.includes(kind) &&
    config.providers.filter((provider) => provider.kind === kind).length > 1

  // Tab enters the list on the selected row, or on the first one when a filter hides it.
  const focusableKey = rows.some((row) => row.entry.key === effectiveKey) ? effectiveKey : rows[0]?.entry.key
  const groupedRows: Array<{ group: AccountGroup; rows: Row[] }> = []
  for (const row of rows) {
    const last = groupedRows.at(-1)
    if (last?.group === row.group) last.rows.push(row)
    else groupedRows.push({ group: row.group, rows: [row] })
  }

  return (
    <div className="@container flex flex-col gap-3">
      {config.storageMode === 'unavailable' && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          {t('settings.noKeyringWarning')}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[160px] flex-1 @2xl:max-w-[260px]">
          <span className="sr-only">{t('settings.accountsSearchPlaceholder')}</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            className={cn(inputCls, 'w-full py-1 pl-8 text-[12px]')}
            placeholder={t('settings.accountsSearchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div
          role="group"
          aria-label={t('settings.accountsFilterLabel')}
          className="flex divide-x divide-border overflow-hidden rounded-md border border-border"
        >
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={cn(
                'px-2.5 py-1 text-[12px] transition-colors',
                filter === value
                  ? 'bg-white/[0.09] text-foreground'
                  : 'text-muted-foreground hover:bg-white/[0.04] hover:text-foreground'
              )}
            >
              {t(`settings.accountsFilter_${value}`)}
            </button>
          ))}
        </div>
        <button type="button" className={cn(primaryButtonCls, 'ml-auto')} onClick={() => setAddIntent({})}>
          <Plus className="h-3.5 w-3.5" /> {t('settings.accountsAdd')}
        </button>
      </div>

      <div className="grid overflow-clip rounded-lg border border-border bg-black/10 @2xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        <div className={cn('border-border @2xl:border-r', showDetail && 'hidden @2xl:block')}>
          <div className="overflow-y-auto pb-1.5 @2xl:sticky @2xl:top-12 @2xl:max-h-[calc(100vh-10rem)]">
            <p
              className="flex flex-wrap gap-x-2.5 gap-y-0.5 border-b border-border/70 px-3.5 py-2 text-[11px] text-muted-foreground"
              aria-live="polite"
            >
              <span>{t('settings.accountsSummaryConnected', { count: connectedCount })}</span>
              {attentionCount > 0 && (
                <span className="text-amber-300">
                  {t('settings.accountsSummaryAttention', { count: attentionCount })}
                </span>
              )}
              {nearLimitCount > 0 && <span>{t('settings.accountsSummaryNearLimit', { count: nearLimitCount })}</span>}
            </p>
            {rows.length > 0 && (
              <div
                ref={listRef}
                role="listbox"
                aria-label={t('settings.accountsListLabel')}
                onKeyDown={onListKeyDown}
                className="flex flex-col"
              >
                {groupedRows.map(({ group, rows: groupRows }) => (
                  <div key={group.id} role="group" aria-label={groupName(group)}>
                    <p
                      aria-hidden="true"
                      className="px-3.5 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      {groupName(group)}
                    </p>
                    {groupRows.map((row) => {
                      const selected = row.entry.key === effectiveKey
                      const dot =
                        row.summary.health === 'ok' && row.summary.limitReached
                          ? ('limit' as const)
                          : row.summary.health
                      return (
                        <button
                          key={row.entry.key}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          tabIndex={row.entry.key === focusableKey ? 0 : -1}
                          data-account-entry={row.entry.key}
                          onClick={() => select(row.entry.key)}
                          className={cn(
                            'grid w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2.5 border-l-2 px-3 py-1.5 text-left transition-colors',
                            selected ? 'border-indigo-400 bg-white/[0.07]' : 'border-transparent hover:bg-white/[0.035]'
                          )}
                        >
                          <ProviderMark kind={markKind(row.entry)} dot={dot} />
                          <span className="min-w-0">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate text-[13px] text-foreground">{row.title}</span>
                              {row.rotation && (
                                <span
                                  role="img"
                                  aria-label={t('settings.accountRotationOn')}
                                  title={t('settings.accountRotationOn')}
                                  className="shrink-0 text-muted-foreground"
                                >
                                  <Repeat className="size-3" aria-hidden="true" />
                                </span>
                              )}
                            </span>
                            <span
                              className={cn(
                                'block truncate text-[11px]',
                                row.metaTone === 'bad'
                                  ? 'text-rose-300'
                                  : row.metaTone === 'warn'
                                    ? 'text-amber-300'
                                    : 'text-muted-foreground'
                              )}
                            >
                              {row.meta}
                            </span>
                          </span>
                          {row.entry.type === 'subscription' && row.summary.connected ? (
                            <UsageGauge
                              usage={(snapshots[row.entry.key] as SubscriptionAccountSnapshot | undefined)?.usage}
                            />
                          ) : (
                            <span />
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}

            {rows.length === 0 && !browsing && (
              <div className="px-4 py-8 text-center text-[12px] text-muted-foreground">
                <p>
                  {query.trim()
                    ? t('settings.accountsNoMatch', { query: query.trim() })
                    : t('settings.accountsNoMatchFilter')}
                </p>
                <button
                  type="button"
                  className="mt-2 text-[12px] text-indigo-300 hover:text-indigo-200"
                  onClick={clearFilters}
                >
                  {t('settings.accountsShowAll')}
                </button>
              </div>
            )}
            {listedCount === 0 && browsing && (
              <p className="px-4 pb-1 pt-3 text-[12px] text-muted-foreground">{t('settings.accountsEmpty')}</p>
            )}

            {chips.length > 0 && (
              <div className={cn('px-3.5 pb-2.5 pt-3', rows.length > 0 && 'mt-1.5 border-t border-border/70')}>
                <p className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('settings.accountsAvailable')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {chips.map((group) => (
                    <button
                      key={group.id}
                      type="button"
                      data-account-chip={group.id}
                      onClick={() => select(group.entries[0].key)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border py-0.5 pl-0.5 pr-2.5 text-[12px] text-muted-foreground transition-colors hover:border-solid hover:bg-white/[0.04] hover:text-foreground"
                    >
                      <ProviderMark kind={markKind(group.entries[0])} size="sm" />
                      {groupName(group)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className={cn('min-w-0 p-4 @2xl:p-5', !showDetail && 'hidden @2xl:block')}>
          {allEntries.map(({ entry }) => {
            const selected = entry.key === effectiveKey
            if (entry.type === 'subscription') {
              return (
                <SubscriptionAccount
                  key={entry.key}
                  entry={entry}
                  config={config}
                  selected={selected}
                  autoLogin={pendingLogin === entry.key}
                  onAutoLoginHandled={() => setPendingLogin(null)}
                  onSnapshot={reportSnapshot}
                  onConnectAnother={(kind) => setAddIntent({ kind, newAccount: true })}
                  onBack={back}
                  showSubscriptionFailover={showSubscriptionFailover(entry.providerKind)}
                  onChanged={onChanged}
                  onModelFilterChanged={onModelFilterChanged}
                />
              )
            }
            if (entry.type === 'chatgpt-web') {
              return (
                <ChatGptWebSettings
                  key={entry.key}
                  selected={selected}
                  onSnapshot={reportSnapshot}
                  onBack={back}
                  onChanged={onChanged}
                />
              )
            }
            return selected ? (
              <ApiKeyAccount
                key={entry.key}
                entry={entry}
                keyringAvailable={config.storageMode !== 'unavailable'}
                onBack={back}
                onChanged={onChanged}
                onModelFilterChanged={onModelFilterChanged}
              />
            ) : null
          })}
          {effectiveKey === null && (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <p className="max-w-sm text-[12px] text-muted-foreground">{t('settings.accountsSelectHint')}</p>
              <button type="button" className={primaryButtonCls} onClick={() => setAddIntent({})}>
                <Plus className="h-3.5 w-3.5" /> {t('settings.accountsAdd')}
              </button>
            </div>
          )}
        </div>
      </div>

      <AddAccountDialog
        intent={addIntent}
        config={config}
        snapshots={snapshots}
        onClose={() => setAddIntent(null)}
        onChanged={onChanged}
        onSubscriptionReady={(providerId) => {
          setAddIntent(null)
          selectWhenListed(providerId)
          setPendingLogin(providerId)
        }}
        onChatGptWeb={() => {
          setAddIntent(null)
          select(CHATGPT_WEB_ENTRY_KEY)
        }}
        onApiProviderAdded={(providerId) => {
          setAddIntent(null)
          if (providerId) selectWhenListed(providerId)
        }}
      />
    </div>
  )
}
