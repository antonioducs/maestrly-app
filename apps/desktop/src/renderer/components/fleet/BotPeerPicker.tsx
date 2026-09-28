import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import type { FleetBot, FleetEnvironment } from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { filterPeerGroups, foldText, peerGroups } from '@/lib/fleet/create-bot'
import { fixedContainingBlock } from '@/lib/fixed-panel-position'
import { cn } from '@/lib/utils'

/** Chips shown under the field before the rest collapse into a count. */
const CHIPS_SHOWN = 10
const PANEL_HEIGHT = 360

/** The first match of `query` in `text` (ignoring case and accents), marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = foldText(query.trim())
  const at = q ? foldText(text).indexOf(q) : -1
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-foreground/20 text-inherit">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  )
}

function Avatar({ bot, size = 'sm' }: { bot: Pick<FleetBot, 'name' | 'tint'>; size?: 'sm' | 'xs' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold text-white',
        size === 'sm' ? 'size-[22px] rounded-md text-[10.5px]' : 'size-[18px] rounded-[5px] text-[9.5px]'
      )}
      style={{ background: bot.tint }}
    >
      {bot.name.charAt(0).toUpperCase()}
    </span>
  )
}

/**
 * The bots a bot may message: a searchable list, by environment, where each bot is checked or not, and the chosen
 * ones as removable chips under the field. Scales to many bots, unlike a row per bot.
 */
export function BotPeerPicker({
  bots,
  environments,
  selfId,
  value,
  onChange,
  labelledBy,
}: {
  bots: FleetBot[]
  /** Given when bots live in environments: the list groups by them and a search matches their names. */
  environments?: FleetEnvironment[]
  selfId?: string
  value: string[]
  onChange: (value: string[]) => void
  /** The heading the field belongs to. */
  labelledBy?: string
}) {
  const { t } = useTranslation('fleet')
  const id = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [style, setStyle] = useState<CSSProperties>()
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const chipList = useRef<HTMLDivElement>(null)
  const groups = peerGroups(bots, environments, selfId)
  const shown = filterPeerGroups(groups, query)
  const flat = shown.flatMap((group) => group.bots)
  const all = groups.flatMap((group) => group.bots)
  const chosen = value.map((botId) => all.find((bot) => bot.id === botId)).filter((bot): bot is FleetBot => !!bot)

  // Fixed, so a scrolling dialog body never clips it; measured against the dialog's containing block.
  const place = useCallback(() => {
    const anchor = trigger.current
    const host = wrap.current
    if (!anchor || !host) return
    const rect = anchor.getBoundingClientRect()
    const container = fixedContainingBlock(host)
    const below = window.innerHeight - rect.bottom - 12
    const above = rect.top - 12
    const up = below < 240 && above > below
    const height = Math.min(PANEL_HEIGHT, up ? above : below)
    const width = Math.max(rect.width, 280)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    setStyle({
      position: 'fixed',
      left: left - container.left,
      width,
      maxHeight: height,
      ...(up ? { bottom: container.bottom - (rect.top - 6) } : { top: rect.bottom + 6 - container.top }),
    })
  }, [])
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false)
    setQuery('')
    if (returnFocus) trigger.current?.focus()
  }, [])
  const openPanel = () => {
    place()
    setQuery('')
    setActive(0)
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const onDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) close(false)
    }
    // Before the dialog around, which would close on the same Escape.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    const onMove = () => place()
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [open, close, place])
  useEffect(() => {
    panel.current?.querySelector(`#${CSS.escape(`${id}-option-${active}`)}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, id])

  const toggle = (botId: string) =>
    onChange(value.includes(botId) ? value.filter((item) => item !== botId) : [...value, botId])
  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!flat.length) return
      setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const bot = flat[active]
      if (bot) toggle(bot.id)
    } else if (event.key === 'Tab') close(false)
  }
  const remove = (botId: string, index: number) => {
    onChange(value.filter((item) => item !== botId))
    // The focus moves to the chip that takes its place, else the field.
    requestAnimationFrame(() => {
      const buttons = chipList.current?.querySelectorAll<HTMLButtonElement>('[data-remove]') ?? []
      ;(buttons[index] ?? buttons[index - 1] ?? trigger.current)?.focus()
    })
  }

  if (!all.length) return <p className="text-[13px] text-muted-foreground">{t('botFields.noPeers')}</p>
  let optionIndex = 0
  return (
    <div ref={wrap} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-labelledby={labelledBy ? `${labelledBy} ${id}-trigger` : undefined}
        id={`${id}-trigger`}
        onClick={() => (open ? close(false) : openPanel())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            openPanel()
          }
        }}
        className="flex min-h-10 w-full items-center gap-2.5 rounded-[9px] border border-input bg-black/25 px-3 py-2 text-left text-sm transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-expanded:border-border-strong"
      >
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 truncate text-muted-foreground">{t('peerPicker.placeholder')}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={panel}
          style={style}
          className="z-[60] flex flex-col rounded-xl border border-border-strong bg-popover p-1.5 backdrop-blur-2xl backdrop-saturate-150 text-popover-foreground shadow-[0_18px_50px_rgba(0,0,0,0.55)] animate-in fade-in-0 zoom-in-[0.985] duration-150 motion-reduce:animate-none"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 pb-2 pt-1 text-muted-foreground">
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            <input
              ref={input}
              role="combobox"
              aria-label={t('peerPicker.search')}
              aria-expanded
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={flat.length ? `${id}-option-${active}` : undefined}
              value={query}
              placeholder={t('peerPicker.search')}
              autoComplete="off"
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={onInputKey}
              className="min-w-0 flex-1 bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div
            id={`${id}-list`}
            role="listbox"
            aria-multiselectable
            aria-label={t('peerPicker.list')}
            className="min-h-0 flex-1 overflow-y-auto pt-1"
          >
            {shown.map((group) => {
              const count = group.bots.filter((bot) => value.includes(bot.id)).length
              const headingId = `${id}-group-${group.environment?.id ?? 'none'}`
              return (
                <div key={group.environment?.id ?? 'none'} role="group" aria-labelledby={headingId}>
                  <div
                    id={headingId}
                    role="presentation"
                    className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-muted-foreground"
                  >
                    <span>
                      {group.environment ? (
                        <Highlight text={group.environment.name} query={query} />
                      ) : environments ? (
                        t('peerPicker.noEnvironment')
                      ) : (
                        t('peerPicker.allBots')
                      )}
                    </span>
                    {count > 0 && <span>{t('peerPicker.groupCount', { count })}</span>}
                  </div>
                  {group.bots.map((bot) => {
                    const index = optionIndex++
                    const selected = value.includes(bot.id)
                    return (
                      <div
                        key={bot.id}
                        id={`${id}-option-${index}`}
                        role="option"
                        aria-selected={selected}
                        onPointerMove={() => setActive(index)}
                        onClick={() => {
                          setActive(index)
                          toggle(bot.id)
                          input.current?.focus()
                        }}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 py-1.5 text-[13px]',
                          index === active && 'bg-foreground/[0.07]'
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                            selected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border-strong bg-foreground/[0.035]'
                          )}
                        >
                          {selected && <Check className="size-[11px]" strokeWidth={3} />}
                        </span>
                        <Avatar bot={bot} />
                        <span className="min-w-0 flex-1 truncate">
                          <Highlight text={bot.name} query={query} />
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                          <span
                            aria-hidden="true"
                            className={cn(
                              'size-1.5 rounded-full',
                              bot.lifecycle === 'running' ? 'bg-status-ready' : 'bg-muted-foreground/70'
                            )}
                          />
                          {t(`status.${bot.status}`)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
            {!shown.length && (
              <p className="px-2.5 py-3.5 text-[12.5px] text-muted-foreground">
                {t('peerPicker.empty', { query: query.trim() })}
              </p>
            )}
          </div>
          <div className="mt-1 flex shrink-0 items-center gap-2 border-t border-border pb-0.5 pl-2.5 pr-1 pt-2 text-xs text-muted-foreground">
            <span role="status">
              {value.length ? t('peerPicker.selected', { count: value.length }) : t('peerPicker.none')}
            </span>
            <span className="ml-auto" />
            {value.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onChange([])
                  input.current?.focus()
                }}
              >
                {t('peerPicker.clear')}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => close(true)}>
              {t('peerPicker.done')}
            </Button>
          </div>
        </div>
      )}

      {chosen.length > 0 && (
        <div ref={chipList} aria-label={t('peerPicker.chosen')} role="group" className="mt-2.5 flex flex-wrap gap-1.5">
          {chosen.slice(0, CHIPS_SHOWN).map((bot, index) => (
            <span
              key={bot.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border-strong bg-foreground/5 py-[3px] pl-1 pr-1 text-[12.5px]"
            >
              <Avatar bot={bot} size="xs" />
              <span className="truncate">{bot.name}</span>
              <button
                type="button"
                data-remove
                aria-label={t('peerPicker.remove', { name: bot.name })}
                onClick={() => remove(bot.id, index)}
                className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
          {chosen.length > CHIPS_SHOWN && (
            <button
              type="button"
              onClick={openPanel}
              className="rounded-lg border border-dashed border-border-strong px-2 py-[3px] text-[12.5px] text-foreground/75 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('peerPicker.more', { count: chosen.length - CHIPS_SHOWN })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
