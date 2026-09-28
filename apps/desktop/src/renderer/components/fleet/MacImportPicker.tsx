import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Copy, LogIn, Plug, Puzzle, Search } from 'lucide-react'
import type { MacInventory } from '../../../shared/fleet-provisioning'
import { Button } from '@/components/ui/button'
import {
  importGroupSize,
  importItemSelected,
  importSections,
  macImportItems,
  toggleImportItem,
  withImportGroup,
  type ImportSection,
  type MacImportItem,
} from '@/lib/fleet/create-bot'
import { nextRadioIndex } from '@/lib/fleet/forms'
import {
  accountHost,
  importGroups,
  type BotProvisioning,
  type ImportChoice,
  type ImportGroup,
} from '@/lib/fleet/provisioning'
import { cn } from '@/lib/utils'

const sectionIcon: Record<ImportSection, ReactNode> = {
  copied: <Copy className="mt-0.5 size-4 shrink-0 text-foreground/75" aria-hidden="true" />,
  signIn: <LogIn className="mt-0.5 size-4 shrink-0 text-foreground/75" aria-hidden="true" />,
  ready: <Puzzle className="mt-0.5 size-4 shrink-0 text-foreground/75" aria-hidden="true" />,
  blocked: <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />,
  works: <Plug className="mt-0.5 size-4 shrink-0 text-foreground/75" aria-hidden="true" />,
  mayFail: <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />,
}

/** Whether a destination already has an item, so sending it again only updates it. */
function alreadyThere(item: MacImportItem, lists: MacImportPickerProps['lists']): boolean {
  if (!lists) return false
  const detail = item.detail
  if (detail.kind === 'api-key')
    return !!lists.accounts?.apiKeys.some(
      (key) => key.name === item.name && accountHost(key.kind, key.baseURL) === detail.host
    )
  if (detail.kind === 'skill') return !!lists.skills?.some((skill) => skill.name === item.name)
  if (detail.kind === 'mcp') return !!lists.mcpServers?.some((server) => server.name === item.name)
  return false
}

type MacImportPickerProps = {
  inventory: MacInventory
  value: ImportChoice
  onChange: (value: ImportChoice) => void
  groups?: ImportGroup[]
  /** What the destination already has, marked on its items. */
  lists?: Pick<BotProvisioning, 'accounts' | 'skills' | 'mcpServers'>
  /** The tab it opens on. */
  initialGroup?: ImportGroup
  /** Fills its container: tabs and tools stay put while the items scroll. */
  fill?: boolean
}

/**
 * What to bring from this Mac: one tab per kind, a search, and the items grouped by what happens to them (copied or
 * signed in again, sent or blocked, working anywhere or depending on this Mac).
 */
export function MacImportPicker({
  inventory,
  value,
  onChange,
  groups = importGroups,
  lists,
  initialGroup,
  fill = false,
}: MacImportPickerProps) {
  const { t, i18n } = useTranslation('fleet')
  const id = useId()
  const items = macImportItems(inventory)
  const [group, setGroup] = useState<ImportGroup>(
    initialGroup && groups.includes(initialGroup) ? initialGroup : groups[0]
  )
  const [query, setQuery] = useState('')
  const [onlySelected, setOnlySelected] = useState(false)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const sections = importSections(items[group], group, { query, onlySelected: onlySelected ? value : undefined })
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextRadioIndex(index, event.key, groups.length)
    if (next === null) return
    event.preventDefault()
    setGroup(groups[next])
    tabs.current[next]?.focus()
  }
  const detailText = (item: MacImportItem): string => {
    const detail = item.detail
    switch (detail.kind) {
      case 'api-key':
        return t('provisioning.picker.apiKey', { host: detail.host })
      case 'copy':
        return [
          t('provisioning.copyNote'),
          detail.expiresAt
            ? t('provisioning.expires', { date: new Date(detail.expiresAt).toLocaleDateString(i18n.language) })
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
      case 'login':
        return detail.email ? t('provisioning.signInAs', { email: detail.email }) : t('provisioning.picker.signIn')
      case 'skill':
        return [
          detail.description,
          t('provisioning.files', { count: detail.files }),
          detail.scripts ? t('provisioning.hasScripts') : '',
        ]
          .filter(Boolean)
          .join(' · ')
      case 'mcp':
        return detail.target
    }
  }
  const panelId = `${id}-panel`
  return (
    <div className={cn('flex flex-col', fill && 'min-h-0 flex-1')}>
      <div className={cn('flex shrink-0 flex-col gap-3', fill && 'border-b border-border px-6 pb-3')}>
        {groups.length > 1 && (
          <div
            role="tablist"
            aria-label={t('provisioning.picker.tabs')}
            className="grid gap-0.5 rounded-[10px] border border-input bg-black/25 p-[3px]"
            style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}
          >
            {groups.map((name, index) => (
              <button
                key={name}
                ref={(node) => {
                  tabs.current[index] = node
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${name}`}
                aria-selected={group === name}
                aria-controls={panelId}
                tabIndex={group === name ? 0 : -1}
                onClick={() => setGroup(name)}
                onKeyDown={(event) => onTabKey(event, index)}
                className={cn(
                  'flex items-center justify-center gap-1.5 rounded-[7px] px-2 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  group === name ? 'bg-primary/[0.12] text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t(`provisioning.groups.${name}`)}
                <span className="text-[11.5px] tabular-nums text-muted-foreground">
                  {importGroupSize(value, name)}/{items[name].length}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-44 flex-1 items-center gap-2 rounded-[9px] border border-input bg-black/25 px-2.5 text-muted-foreground focus-within:border-ring">
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t(`provisioning.picker.search.${group}`)}
              aria-label={t(`provisioning.picker.search.${group}`)}
              aria-controls={panelId}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <button
            type="button"
            aria-pressed={onlySelected}
            onClick={() => setOnlySelected((current) => !current)}
            className={cn(
              'h-[30px] rounded-lg border px-2.5 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              onlySelected
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border-strong text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`provisioning.picker.onlySelected.${group}`)}
          </button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(withImportGroup(value, inventory, group, 'recommended'))}
          >
            {t(`provisioning.picker.recommended.${group}`)}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onChange(withImportGroup(value, inventory, group, 'clear'))}>
            {t('provisioning.clear')}
          </Button>
        </div>
      </div>
      <div
        id={panelId}
        role={groups.length > 1 ? 'tabpanel' : undefined}
        aria-labelledby={groups.length > 1 ? `${id}-tab-${group}` : undefined}
        className={cn(fill && 'min-h-0 flex-1 overflow-y-auto px-6 pb-6')}
      >
        {sections.map(({ section, items: sectionItems }, sectionIndex) => (
          <section key={section} aria-labelledby={`${id}-${section}`}>
            <div className={cn('flex items-start gap-2.5 px-0.5 pb-2', sectionIndex === 0 ? 'pt-3' : 'pt-4')}>
              {sectionIcon[section]}
              <div>
                <h4 id={`${id}-${section}`} className="text-[13px] font-semibold">
                  {t(`provisioning.section.${section}.title`)}
                </h4>
                <p className="text-xs text-muted-foreground">{t(`provisioning.section.${section}.note`)}</p>
              </div>
            </div>
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-foreground/[0.025]">
              {sectionItems.map((item) => {
                const inputId = `${id}-${item.field}-${item.id}`
                const selected = importItemSelected(value, item)
                return (
                  <li key={`${item.field}:${item.id}`}>
                    <label
                      htmlFor={inputId}
                      className={cn(
                        'flex items-start gap-3 px-3.5 py-2.5 transition-colors',
                        item.disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-foreground/[0.02]'
                      )}
                    >
                      <input
                        id={inputId}
                        type="checkbox"
                        aria-label={item.name}
                        aria-describedby={`${inputId}-detail`}
                        disabled={item.disabled}
                        checked={selected}
                        onChange={(event) => onChange(toggleImportItem(value, item, event.target.checked))}
                        className="mt-0.5"
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-px">
                        <span
                          className={cn(
                            'flex flex-wrap items-center gap-2 text-[13.5px] font-medium',
                            item.disabled && 'text-muted-foreground'
                          )}
                        >
                          {item.name}
                          {item.detail.kind === 'mcp' && (
                            <span className="rounded-md border border-border-strong px-1.5 text-[11px] font-normal text-muted-foreground">
                              {item.detail.transport}
                            </span>
                          )}
                          {alreadyThere(item, lists) && (
                            <span className="rounded-md border border-border-strong px-1.5 text-[11px] font-normal text-muted-foreground">
                              {t('provisioning.alreadyOnBot')}
                            </span>
                          )}
                        </span>
                        <span
                          id={`${inputId}-detail`}
                          className={cn(
                            'text-xs text-muted-foreground',
                            item.detail.kind === 'mcp' ? 'truncate font-mono text-[11.5px]' : 'line-clamp-2'
                          )}
                        >
                          {detailText(item)}
                          {item.warnings.length > 0 && (
                            <span className="sr-only">
                              . {item.warnings.map((warning) => t(`provisioning.warning.${warning}`)).join('. ')}
                            </span>
                          )}
                        </span>
                        {item.warnings.map((warning) => (
                          <span
                            key={warning}
                            aria-hidden="true"
                            className="mt-0.5 flex items-center gap-1.5 text-xs text-amber-300"
                          >
                            <AlertTriangle className="size-3 shrink-0" />
                            {t(`provisioning.warning.${warning}`)}
                          </span>
                        ))}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {!sections.length && (
          <p className="px-3 py-7 text-center text-[13px] text-muted-foreground">
            {query.trim()
              ? t('provisioning.picker.noMatch', { query: query.trim() })
              : onlySelected
                ? t('provisioning.picker.noneSelected')
                : t('provisioning.nothing')}
          </p>
        )}
      </div>
    </div>
  )
}
