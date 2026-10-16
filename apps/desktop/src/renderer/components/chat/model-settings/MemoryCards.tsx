import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useHostApi, useHostId } from '@/lib/hosts/host-context'
import type { OpenMemoryRequest } from '@/lib/memory-target'
import type { ChatConfig } from '../../../../shared/chat'
import type { MemorySettings, PersonalMemorySettings } from '../../../../shared/memory'
import { SaveNote, SettingSwitch } from './controls'
import type { ModelSelection } from './model-selection'

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  autoRecall: true,
  extraction: { enabled: false, selection: null },
}

export const projectMemorySettings = (config: ChatConfig): MemorySettings => config.memory ?? DEFAULT_MEMORY_SETTINGS

export interface PersonalMemoryState {
  settings: PersonalMemorySettings | null
  loadError: boolean
  retry: () => void
  /** Saves and shows the result right away; the change event that follows confirms it. */
  save: (settings: PersonalMemorySettings) => Promise<void>
}

/** The host's personal memory settings, kept current when they change elsewhere (its dialog, another window). */
export function usePersonalMemorySettings(): PersonalMemoryState {
  const api = useHostApi()
  const [settings, setSettings] = useState<PersonalMemorySettings | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    let receivedEvent = false
    setLoadError(false)
    const unsubscribe = api.onPersonalMemorySettingsChanged((next) => {
      receivedEvent = true
      if (active) setSettings(next)
    })
    void api
      .getPersonalMemorySettings()
      .then((next) => {
        if (active && !receivedEvent) setSettings(next)
      })
      .catch(() => {
        if (active && !receivedEvent) setLoadError(true)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api, attempt])

  const save = useCallback(
    async (next: PersonalMemorySettings) => {
      await api.setPersonalMemorySettings(next)
      setSettings(next)
    },
    [api]
  )
  return { settings, loadError, retry: () => setAttempt((value) => value + 1), save }
}

/** The one model that extracts memories, shared by project and personal memory; the project's comes first. */
export function memoryExtractionModel(
  project: MemorySettings,
  personal: PersonalMemorySettings | null
): ModelSelection | null {
  return project.extraction.selection ?? personal?.extraction.selection ?? null
}

function Option({
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  hint: ReactNode
  onChange: (checked: boolean) => void
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-2.5 border-t border-border/70 py-2.5 text-[12px] first-of-type:border-t-0',
        disabled && 'opacity-50'
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 accent-primary"
      />
      <span className="min-w-0">
        <span className="text-foreground">{label}</span>
        <span className="mt-0.5 block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function Card({
  id,
  title,
  description,
  action,
  children,
  footer,
}: {
  id: string
  title: string
  description: string
  action?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col rounded-lg border border-border bg-white/[0.02] px-3.5 pt-3 pb-1.5"
    >
      <header className="flex items-start justify-between gap-3 pb-1.5">
        <div className="min-w-0">
          <h4 id={id} className="text-[13px] font-medium text-foreground">
            {title}
          </h4>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        </div>
        {action}
      </header>
      {children}
      {footer}
    </section>
  )
}

/** "Uses gpt-x · change", or the way to choose a model when none is set. */
function ExtractionHint({ model, onPickModel }: { model: ModelSelection | null; onPickModel: () => void }) {
  const { t } = useTranslation('chat')
  return (
    <>
      {model ? t('modelSettings.memory.usesModel') : t('modelSettings.memory.needsModel')}{' '}
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault()
          onPickModel()
        }}
        className="text-indigo-300 underline-offset-2 hover:underline"
      >
        {model ? model.modelId : t('modelSettings.memory.chooseModel')}
      </button>
    </>
  )
}

export function MemoryCards({
  config,
  personal,
  locked,
  onChanged,
  onPickModel,
}: {
  config: ChatConfig
  personal: PersonalMemoryState
  locked: boolean
  onChanged: () => void
  onPickModel: () => void
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const hostId = useHostId()
  const persistedProject = projectMemorySettings(config)
  const [project, setProject] = useState(persistedProject)
  const [projectNote, setProjectNote] = useState<{ error: boolean; text: string } | null>(null)
  const [personalNote, setPersonalNote] = useState<{ error: boolean; text: string } | null>(null)
  const [savingProject, setSavingProject] = useState(false)
  const [savingPersonal, setSavingPersonal] = useState(false)
  const model = memoryExtractionModel(persistedProject, personal.settings)
  const projectKey = JSON.stringify(persistedProject)
  // The serialized key stands for the persisted value, which is a new object on every config refresh.
  useEffect(() => setProject(persistedProject), [projectKey])

  const saveProject = async (next: MemorySettings) => {
    const previous = project
    setProject(next)
    setSavingProject(true)
    setProjectNote(null)
    try {
      const result = await api.chatSetMemorySettings(next)
      if (!result.ok) {
        setProject(previous)
        setProjectNote({
          error: true,
          text:
            result.error === 'memory-model-required'
              ? t('memorySettings.modelRequired')
              : result.error || t('memorySettings.saveFailed'),
        })
        return
      }
      setProjectNote({ error: false, text: t('memorySettings.saved') })
      onChanged()
    } catch {
      setProject(previous)
      setProjectNote({ error: true, text: t('memorySettings.saveFailed') })
    } finally {
      setSavingProject(false)
    }
  }

  const savePersonal = async (next: PersonalMemorySettings) => {
    setSavingPersonal(true)
    setPersonalNote(null)
    try {
      await personal.save(next)
      setPersonalNote({ error: false, text: t('memorySettings.saved') })
    } catch {
      setPersonalNote({ error: true, text: t('memorySettings.saveFailed') })
    } finally {
      setSavingPersonal(false)
    }
  }

  const personalSettings = personal.settings
  const withModel = <T extends MemorySettings>(settings: T, enabled: boolean): T => ({
    ...settings,
    extraction: {
      enabled,
      selection: enabled ? (settings.extraction.selection ?? model) : settings.extraction.selection,
    },
  })

  return (
    <div className="grid grid-cols-1 gap-2.5 @xl:grid-cols-2">
      <Card
        id="project-memory-settings-heading"
        title={t('modelSettings.memory.projectTitle')}
        description={t('memorySettings.description')}
        footer={<SaveNote note={projectNote} className="pb-1.5" />}
      >
        <fieldset disabled={locked || savingProject} className="m-0 flex min-w-0 flex-col border-0 p-0">
          <Option
            checked={project.autoRecall}
            label={t('memorySettings.autoRecall')}
            hint={t('memorySettings.autoRecallHint')}
            onChange={(autoRecall) => void saveProject({ ...project, autoRecall })}
          />
          <Option
            checked={project.extraction.enabled}
            disabled={!model && !project.extraction.enabled}
            label={t('memorySettings.extraction')}
            hint={<ExtractionHint model={model} onPickModel={onPickModel} />}
            onChange={(enabled) => void saveProject(withModel(project, enabled))}
          />
        </fieldset>
      </Card>
      <Card
        id="personal-memory-settings-heading"
        title={t('personalMemorySettings.title')}
        description={t('personalMemorySettings.description')}
        action={
          personalSettings && (
            <SettingSwitch
              checked={personalSettings.enabled}
              label={t('personalMemorySettings.enabled')}
              disabled={locked || savingPersonal}
              onChange={(enabled) => void savePersonal({ ...personalSettings, enabled })}
            />
          )
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5">
            {/* The memory center opens on the personal memory of the host these settings are of. */}
            <button
              type="button"
              className="text-[11px] text-indigo-300 underline-offset-2 hover:underline"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent<OpenMemoryRequest>('maestrly:open-memory', { detail: { personal: true, hostId } })
                )
              }
            >
              {t('personalMemorySettings.manage')}
            </button>
            <SaveNote note={personalNote} />
          </div>
        }
      >
        {!personalSettings ? (
          <div
            role={personal.loadError ? 'alert' : 'status'}
            className="flex items-center gap-2 py-2.5 text-[11px] text-muted-foreground"
          >
            {t(personal.loadError ? 'personalMemorySettings.loadFailed' : 'personalMemorySettings.loading')}
            {personal.loadError && (
              <Button variant="outline" size="sm" onClick={personal.retry}>
                {t('personalMemorySettings.retry')}
              </Button>
            )}
          </div>
        ) : (
          <fieldset
            disabled={locked || savingPersonal || !personalSettings.enabled}
            className="m-0 flex min-w-0 flex-col border-0 p-0"
          >
            <Option
              checked={personalSettings.autoRecall}
              disabled={!personalSettings.enabled}
              label={t('memorySettings.autoRecall')}
              hint={t('modelSettings.memory.personalRecallHint')}
              onChange={(autoRecall) => void savePersonal({ ...personalSettings, autoRecall })}
            />
            <Option
              checked={personalSettings.extraction.enabled}
              disabled={!personalSettings.enabled || (!model && !personalSettings.extraction.enabled)}
              label={t('memorySettings.extraction')}
              hint={<ExtractionHint model={model} onPickModel={onPickModel} />}
              onChange={(enabled) => void savePersonal(withModel(personalSettings, enabled))}
            />
          </fieldset>
        )}
      </Card>
    </div>
  )
}
