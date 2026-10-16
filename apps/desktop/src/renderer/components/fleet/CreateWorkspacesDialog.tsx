import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check } from 'lucide-react'
import {
  FLEET_NAME_MAX,
  FLEET_WORKSPACES_ENVIRONMENTS_FEATURE,
  type FleetEnvironment,
} from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  ENVIRONMENT_TINTS,
  cpuLimitChoices,
  cpuLimitFromValue,
  idleStopChoices,
  idleStopFromValue,
  idleStopParts,
  memoryLimitChoices,
  memoryLimitFromValue,
  nextEnvironmentTint,
} from '@/lib/fleet/environments'
import { fleetErrorText } from '@/lib/fleet/errors'
import type { FleetController } from '@/lib/fleet/use-fleet'
import { cn } from '@/lib/utils'

const fieldInput =
  'w-full rounded-[9px] border border-input bg-black/25 px-3 py-2 text-sm transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-border-strong focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-[invalid=true]:border-destructive'

function Field({ id, label, note, children }: { id: string; label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label}
      </label>
      {children}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

/** The swatches an environment's color is chosen from: one radio group, moved through with the arrow keys. */
export function TintPicker({
  value,
  onChange,
  labelledBy,
  disabled,
}: {
  value: string
  onChange: (tint: string) => void
  labelledBy: string
  disabled?: boolean
}) {
  const { t } = useTranslation('fleet')
  const index = Math.max(0, (ENVIRONMENT_TINTS as readonly string[]).indexOf(value.toLowerCase()))
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      {ENVIRONMENT_TINTS.map((tint, at) => {
        const selected = tint === value.toLowerCase()
        return (
          <button
            key={tint}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={t('workspaces.tintOption', { number: at + 1 })}
            tabIndex={at === index ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(tint)}
            onKeyDown={(event) => {
              const step =
                event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                    ? -1
                    : 0
              if (!step) return
              event.preventDefault()
              const next = (at + step + ENVIRONMENT_TINTS.length) % ENVIRONMENT_TINTS.length
              onChange(ENVIRONMENT_TINTS[next])
              const group = event.currentTarget.parentElement
              ;(group?.children[next] as HTMLElement | undefined)?.focus()
            }}
            className={cn(
              'grid size-7 place-items-center rounded-full outline-none ring-offset-2 ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              selected && 'ring-2 ring-foreground/70'
            )}
            style={{ backgroundColor: tint }}
          >
            {selected && <Check aria-hidden="true" className="size-3.5 text-white drop-shadow" />}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A new workspaces environment: one scope of the owner's work (personal, a company…) in a Maestrly of its own on the
 * server, with its own network, folder, accounts and site logins. Its name and color tell it apart in the sidebar.
 */
export function CreateWorkspacesDialog({
  fleet,
  onClose,
  onCreated,
}: {
  fleet: FleetController
  onClose: () => void
  onCreated: (environment: FleetEnvironment) => void
}) {
  const { t } = useTranslation('fleet')
  const id = useId()
  const { environments, host } = fleet.state.snapshot
  // An older server takes a name and a memory limit only.
  const scoped = fleet.state.connection.features.includes(FLEET_WORKSPACES_ENVIRONMENTS_FEATURE)
  const [name, setName] = useState('')
  const [tint, setTint] = useState(() => nextEnvironmentTint(environments.map((environment) => environment.tint)))
  const [memory, setMemory] = useState('default')
  const [cpus, setCpus] = useState('none')
  const [idle, setIdle] = useState('never')
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    if (busy) return
    const trimmed = name.trim()
    if (!trimmed) {
      setInvalid(true)
      return
    }
    setBusy(true)
    setError('')
    try {
      const environment = await window.api.fleetCreateWorkspaces({
        name: trimmed,
        memoryLimitBytes: memoryLimitFromValue(memory),
        ...(scoped ? { tint, cpuLimit: cpuLimitFromValue(cpus), idleStopMinutes: idleStopFromValue(idle) } : {}),
      })
      fleet.dispatch({
        type: 'event',
        value: { type: 'environment.updated', at: new Date().toISOString(), environment },
      })
      onCreated(environment)
    } catch (cause) {
      setError(fleetErrorText(cause, t))
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent
        data-testid="create-workspaces"
        className="flex max-h-[calc(100vh-80px)] max-w-[560px] flex-col gap-0 overflow-hidden p-0 sm:rounded-2xl"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          }
        }}
      >
        <div className="shrink-0 px-6 pb-3.5 pt-5">
          <DialogTitle className="pr-8 text-[17px] tracking-[-0.01em]">{t('workspaces.createTitle')}</DialogTitle>
          <DialogDescription className="mt-1 text-[13px]">{t('workspaces.createDescription')}</DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 pt-1.5">
          <Field id={id + '-name'} label={t('workspaces.nameLabel')}>
            <input
              id={id + '-name'}
              className={fieldInput}
              value={name}
              maxLength={FLEET_NAME_MAX}
              autoComplete="off"
              autoFocus
              placeholder={t('workspaces.namePlaceholder')}
              aria-invalid={invalid}
              aria-describedby={invalid ? id + '-name-error' : undefined}
              onChange={(event) => {
                setName(event.target.value)
                if (event.target.value.trim()) setInvalid(false)
              }}
            />
            {invalid && (
              <p id={id + '-name-error'} className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="size-3" aria-hidden="true" />
                {t('workspaces.nameRequired')}
              </p>
            )}
          </Field>
          {scoped && (
            <div className="flex flex-col gap-1.5">
              <span id={id + '-tint'} className="text-[13px] font-medium">
                {t('workspaces.tintLabel')}
              </span>
              <TintPicker value={tint} onChange={setTint} labelledBy={id + '-tint'} disabled={busy} />
              <p className="text-xs text-muted-foreground">{t('workspaces.tintNote')}</p>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={id + '-memory'} label={t('environment.memoryLimit')}>
              <Select value={memory} disabled={busy} onValueChange={setMemory}>
                <SelectTrigger id={id + '-memory'} aria-label={t('environment.memoryLimit')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {memoryLimitChoices(null).map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.gb === null
                        ? t('environment.memoryLimitDefault')
                        : t('environment.memoryLimitValue', { value: choice.gb })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {scoped && (
              <Field id={id + '-cpu'} label={t('environment.cpuLimit')}>
                <Select value={cpus} disabled={busy} onValueChange={setCpus}>
                  <SelectTrigger id={id + '-cpu'} aria-label={t('environment.cpuLimit')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {cpuLimitChoices(null, host?.cpus ?? null).map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.cpus === null
                          ? t('environment.cpuLimitNone')
                          : t('environment.cpuLimitValue', { count: choice.cpus })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </div>
          {scoped && (
            <Field id={id + '-idle'} label={t('workspaces.idleStop')} note={t('workspaces.idleStopNote')}>
              <Select value={idle} disabled={busy} onValueChange={setIdle}>
                <SelectTrigger id={id + '-idle'} aria-label={t('workspaces.idleStop')} className="sm:w-1/2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {idleStopChoices(null).map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.minutes === null
                        ? t('workspaces.idleStopNever')
                        : t(`workspaces.idleStopAfter.${idleStopParts(choice.minutes).unit}`, {
                            count: idleStopParts(choice.minutes).count,
                          })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <p className="rounded-lg border border-border bg-white/[0.03] px-3 py-2.5 text-xs text-muted-foreground">
            {t('workspaces.createNote')}
          </p>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border py-3 pl-6 pr-4">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('create.cancel')}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {t(busy ? 'workspaces.creating' : 'workspaces.createSubmit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
