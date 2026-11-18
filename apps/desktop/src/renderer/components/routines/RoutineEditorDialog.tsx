import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Clock, Hand, Loader2, ShieldAlert, TerminalSquare, X } from 'lucide-react'
import type { ChatModelMeta, ChatModelRef, ChatPermMode, ChatReasoningEffort } from '../../../shared/chat'
import { LOCAL_HOST_ID } from '../../../shared/host-key'
import type {
  LocalRoutine,
  RoutineDraft,
  RoutineMissed,
  RoutineModel,
  RoutineNotify,
  RoutineRetentionDays,
  RoutineSavedPermission,
  RoutineUpdatePatch,
} from '../../../shared/routines'
import { hostApi } from '@/lib/hosts/host-context'
import {
  draftFromForm,
  formFromDraft,
  systemTimeZone,
  validateEditorForm,
  type RoutineEditorForm,
} from '@/lib/routines/editor-form'
import { formatHHMM, formatUpcomingDay } from '@/lib/routines/relative-time'
import { upcomingRunDates } from '@/lib/routines/schedule-text'
import { cn } from '@/lib/utils'
import { ChatModelChip } from '@/components/chat/ChatModelChip'
import { ChatReasoningPicker } from '@/components/chat/ChatReasoningPicker'
import { FastModeChip } from '@/components/chat/ChatFastModeToggle'
import { loadModelPickerRows } from '@/components/chat/model-picker-rows'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { SearchSelect, type SearchOption } from '@/components/ui/search-select'
import { RoutineSavedPermissionLabel } from './RoutineOutcomeBadge'

export type RoutineEditorTarget =
  | {
      kind: 'new'
      initialInstruction?: string
      initialModel?: RoutineModel
      initialPermMode?: ChatPermMode
      sourceConversationId?: string
      originTitle?: string
      onCreated?: () => void
    }
  | {
      kind: 'proposal'
      draft: RoutineDraft
      originTitle?: string
      onConfirmDraft: (draft: RoutineDraft) => Promise<void> | void
    }
  | {
      kind: 'edit'
      routine: LocalRoutine
      originTitle?: string
    }

const DEFAULT_MODEL = {
  providerId: '',
  modelId: '',
  reasoning: 'off' as ChatReasoningEffort,
  fastMode: false,
}

function initialFormForTarget(target: RoutineEditorTarget): RoutineEditorForm {
  if (target.kind === 'edit') {
    return formFromDraft({
      title: target.routine.title,
      instruction: target.routine.instruction,
      schedule: target.routine.schedule,
      permMode: target.routine.permMode,
      model: target.routine.model,
      notify: target.routine.notify,
      missed: target.routine.missed,
      retentionDays: target.routine.retentionDays,
    })
  }
  if (target.kind === 'proposal') {
    return formFromDraft(target.draft)
  }
  return formFromDraft({
    title: '',
    instruction: target.initialInstruction ?? '',
    schedule: { kind: 'weekly', time: '09:00', days: [1, 2, 3, 4, 5], timezone: systemTimeZone() },
    permMode: target.initialPermMode ?? 'auto',
    model: target.initialModel ? { ...target.initialModel } : { ...DEFAULT_MODEL },
    notify: 'notable',
    missed: 'catchup',
    retentionDays: 30,
  })
}

function buildTimezoneOptions(): SearchOption[] {
  const zones =
    typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function'
      ? Intl.supportedValuesOf('timeZone')
      : [systemTimeZone(), 'UTC']
  return zones.map((id) => ({ id, label: id.replaceAll('_', ' ') }))
}

const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const
const PERM_OPTIONS: readonly ChatPermMode[] = ['ask', 'auto', 'full']

export function RoutineEditorFormBody({
  target,
  savedPermissions,
  onClose,
  onSaveNew,
  onSaveEdit,
  onRemoveSavedPermission,
}: {
  target: RoutineEditorTarget
  savedPermissions: readonly RoutineSavedPermission[]
  onClose: () => void
  onSaveNew: (draft: RoutineDraft, sourceConversationId?: string) => Promise<void>
  onSaveEdit: (routineId: string, patch: RoutineUpdatePatch) => Promise<void>
  onRemoveSavedPermission: (routineId: string, permId: string) => Promise<void> | void
}) {
  const { t } = useTranslation('routines')
  const { t: tChat } = useTranslation('chat')
  const tr = (key: string, opts?: Record<string, unknown>): string => String(t(key as never, opts as never))

  const titleId = useId()
  const descId = useId()
  const modelLabelId = useId()
  const titleInputId = useId()
  const instructionInputId = useId()
  const timeInputId = useId()
  const everyInputId = useId()
  const unitInputId = useId()
  const notifyInputId = useId()
  const retentionInputId = useId()

  const [form, setForm] = useState<RoutineEditorForm>(() => initialFormForTarget(target))
  const [tried, setTried] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ key: string; value: ChatModelMeta | null } | null>(null)
  const metaGenRef = useRef(0)

  const timezoneOptions = useMemo(() => {
    const base = buildTimezoneOptions()
    if (form.timezone && !base.some((o) => o.id === form.timezone)) {
      return [{ id: form.timezone, label: form.timezone.replaceAll('_', ' ') }, ...base]
    }
    return base
  }, [form.timezone])

  // Reset form when target changes and resolve initial chat/default settings for brand-new routines.
  useEffect(() => {
    const base = initialFormForTarget(target)
    setForm(base)
    setTried(false)
    setSubmitError(null)
    setMeta(null)

    if (target.kind !== 'new') return
    let alive = true
    const localApi = hostApi(LOCAL_HOST_ID)
    const convId = target.sourceConversationId

    void (async () => {
      try {
        const [permMode, selection, reasoning, fastMode] = await Promise.all([
          convId ? localApi.chatGetPermMode(convId).catch(() => null) : localApi.getDefaultPermissionMode().catch(() => null),
          convId ? localApi.chatGetSelection(convId).catch(() => null) : Promise.resolve(null),
          convId ? localApi.chatGetReasoning(convId).catch(() => null) : Promise.resolve(null),
          convId ? localApi.chatGetFastMode(convId).catch(() => false) : Promise.resolve(false),
        ])

        let resolvedSelection = selection?.providerId && selection.modelId ? selection : null
        if (!resolvedSelection) {
          await loadModelPickerRows(localApi, LOCAL_HOST_ID, (update) => {
            if (!resolvedSelection && update.rows.length > 0) {
              const first = update.rows[0]
              resolvedSelection = { providerId: first.providerId, modelId: first.modelId }
            }
          })
        }

        if (!alive) return
        setForm((prev) => ({
          ...prev,
          permMode: permMode ?? prev.permMode,
          model: resolvedSelection
            ? {
                providerId: resolvedSelection.providerId,
                modelId: resolvedSelection.modelId,
                reasoning: reasoning ?? 'off',
                fastMode: fastMode === true,
              }
            : prev.model,
        }))
      } catch {
        // Keep defaults on error
      }
    })()

    return () => {
      alive = false
    }
  }, [target])

  const modelKey = form.model.providerId && form.model.modelId ? `${form.model.providerId}\0${form.model.modelId}` : ''
  useEffect(() => {
    if (!modelKey) return
    const generation = ++metaGenRef.current
    const { providerId, modelId } = form.model
    void hostApi(LOCAL_HOST_ID)
      .chatModelMeta(modelId, providerId)
      .catch(() => null)
      .then((value) => {
        if (metaGenRef.current === generation) {
          setMeta({ key: modelKey, value })
        }
      })
  }, [modelKey, form.model.providerId, form.model.modelId])

  const currentMeta = meta?.key === modelKey ? meta.value : null
  const metaReady = Boolean(modelKey) && meta?.key === modelKey
  const efforts = useMemo(
    () => (currentMeta?.reasoning && currentMeta.reasoningEfforts?.length ? currentMeta.reasoningEfforts : []),
    [currentMeta]
  )
  const fastAvailable = currentMeta?.fastModeCapability === true

  useEffect(() => {
    if (!metaReady) return
    setForm((prev) => {
      let changed = false
      const nextModel = { ...prev.model }
      if (!efforts.length && nextModel.reasoning && nextModel.reasoning !== 'off') {
        nextModel.reasoning = 'off'
        changed = true
      }
      if (!fastAvailable && nextModel.fastMode) {
        nextModel.fastMode = false
        changed = true
      }
      return changed ? { ...prev, model: nextModel } : prev
    })
  }, [efforts.length, fastAvailable, metaReady])

  const validation = useMemo(() => validateEditorForm(form, tr), [form, t])
  const previewValidation = useMemo(
    () => validateEditorForm({ ...form, title: 'x', instruction: 'x' }, tr),
    [form, t]
  )
  const previewDates = useMemo(() => {
    if (!previewValidation.ok) return []
    return upcomingRunDates(previewValidation.draft.schedule, 4)
  }, [previewValidation])

  const activeError =
    submitError ?? (tried && !validation.ok ? validation.message : null)
  const invalidField = tried && !validation.ok ? validation.field : null

  const heading =
    target.kind === 'edit'
      ? t('editor.editTitle')
      : target.kind === 'proposal'
        ? t('editor.proposalTitle')
        : t('editor.newTitle')
  const originSuffix = target.originTitle ? t('editor.subtitleOrigin', { title: target.originTitle }) : ''
  const selection: ChatModelRef | null =
    form.model.providerId && form.model.modelId
      ? { providerId: form.model.providerId, modelId: form.model.modelId }
      : null

  const toggleDay = (day: number) => {
    setForm((prev) => ({
      ...prev,
      days: prev.days.includes(day) ? prev.days.filter((d) => d !== day) : [...prev.days, day],
    }))
  }

  const handleSubmit = async () => {
    setTried(true)
    setSubmitError(null)
    const check = validateEditorForm(form, tr)
    if (!check.ok) return
    if (!check.draft.model.providerId || !check.draft.model.modelId) {
      setSubmitError(tChat('plan.handoff.noModel'))
      return
    }
    setSaving(true)
    try {
      const draft = draftFromForm(form)
      if (target.kind === 'edit') {
        await onSaveEdit(target.routine.id, draft)
      } else if (target.kind === 'proposal') {
        await target.onConfirmDraft(draft)
      } else {
        await onSaveNew(draft, target.sourceConversationId)
        target.onCreated?.()
      }
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'w-full rounded-[8px] border border-border-strong bg-white/[0.03] px-2.5 py-[7px] text-[13px] text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-[rgba(154,149,140,0.58)] focus:border-[rgba(237,234,227,0.45)] focus:shadow-[0_0_0_3px_rgba(237,234,227,0.08)] aria-[invalid=true]:border-[rgba(255,122,133,0.6)]'

  return (
    <>
      <div className="shrink-0 px-[18px] pb-1.5 pt-4">
        <h2 id={titleId} className="m-0 text-[16px] font-semibold tracking-[-0.01em] text-foreground">
          {heading}
        </h2>
        <p id={descId} className="mt-1 text-[12.5px] text-muted-foreground">
          {t('editor.subtitleBase')}
          {originSuffix}.
        </p>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-[18px] pb-1.5 pt-2">
        <div className="grid content-start gap-[5px]">
          <label htmlFor={titleInputId} className="text-[12.5px] font-medium text-foreground/78">
            {t('editor.titleLabel')}
          </label>
          <input
            id={titleInputId}
            type="text"
            maxLength={80}
            value={form.title}
            onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
            aria-invalid={invalidField === 'title' ? 'true' : undefined}
            placeholder={t('editor.titlePlaceholder')}
            className={inputClass}
          />
        </div>

        <div className="grid content-start gap-[5px]">
          <label htmlFor={instructionInputId} className="text-[12.5px] font-medium text-foreground/78">
            {t('editor.instructionLabel')}
          </label>
          <textarea
            id={instructionInputId}
            maxLength={4000}
            value={form.instruction}
            onChange={(e) => setForm((prev) => ({ ...prev, instruction: e.target.value }))}
            aria-invalid={invalidField === 'instruction' ? 'true' : undefined}
            placeholder={t('editor.instructionPlaceholder')}
            className={cn(inputClass, 'min-h-[110px] resize-y leading-normal')}
          />
          <span className="text-[11.5px] text-[rgba(154,149,140,0.58)]">{t('editor.instructionHint')}</span>
        </div>

        <div className="h-px bg-border" />

        <fieldset className="m-0 grid gap-1.5 border-0 p-0">
          <legend className="mb-1.5 text-[12.5px] font-medium text-foreground/78">{t('editor.scheduleLegend')}</legend>
          <div className="routine-seg" role="radiogroup" aria-label={t('editor.scheduleLegend')}>
            {(['weekly', 'interval'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={form.mode === mode}
                onClick={() => setForm((prev) => ({ ...prev, mode }))}
                className="routine-choice"
              >
                <span>{t(mode === 'weekly' ? 'editor.weekly' : 'editor.interval')}</span>
                <span className="routine-mark" />
              </button>
            ))}
          </div>
        </fieldset>

        {form.mode === 'weekly' ? (
          <>
            <div className="grid grid-cols-2 gap-2.5 max-[560px]:grid-cols-1">
              <div className="grid content-start gap-[5px]">
                <label htmlFor={timeInputId} className="text-[12.5px] font-medium text-foreground/78">
                  {t('editor.timeLabel')}
                </label>
                <input
                  id={timeInputId}
                  type="time"
                  value={form.time}
                  onChange={(e) => setForm((prev) => ({ ...prev, time: e.target.value }))}
                  aria-invalid={invalidField === 'time' ? 'true' : undefined}
                  className={cn(inputClass, 'h-[34px] font-mono tabular-nums')}
                />
              </div>
              <div className="grid content-start gap-[5px]">
                <span className="text-[12.5px] font-medium text-foreground/78">{t('editor.timezoneLabel')}</span>
                <SearchSelect
                  value={form.timezone}
                  options={timezoneOptions}
                  onChange={(tz) => setForm((prev) => ({ ...prev, timezone: tz ?? systemTimeZone() }))}
                  invalid={invalidField === 'timezone'}
                  ariaLabel={t('editor.timezoneLabel')}
                  avoidOverflow
                />
              </div>
            </div>

            <fieldset className="m-0 grid gap-1.5 border-0 p-0">
              <legend className="mb-1.5 text-[12.5px] font-medium text-foreground/78">{t('editor.daysLegend')}</legend>
              <div className="flex flex-wrap gap-1">
                {ISO_DAYS.map((day) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={form.days.includes(day)}
                    onClick={() => toggleDay(day)}
                    className={cn(
                      'h-7 min-w-[42px] rounded-[7px] border px-2 text-[12px] transition-colors',
                      form.days.includes(day)
                        ? 'border-[rgba(237,234,227,0.5)] bg-[rgba(237,234,227,0.1)] text-foreground'
                        : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground'
                    )}
                  >
                    {t(`schedule.daysShort.${day}` as never)}
                  </button>
                ))}
              </div>
              <span className="text-[11.5px] text-[rgba(154,149,140,0.58)]">{t('editor.daysHint')}</span>
            </fieldset>
          </>
        ) : (
          <div className="grid gap-1.5">
            <div className="grid grid-cols-2 gap-2.5 max-[560px]:grid-cols-1">
              <div className="grid content-start gap-[5px]">
                <label htmlFor={everyInputId} className="text-[12.5px] font-medium text-foreground/78">
                  {t('editor.everyLabel')}
                </label>
                <input
                  id={everyInputId}
                  type="number"
                  min={1}
                  value={form.everyValue}
                  onChange={(e) => setForm((prev) => ({ ...prev, everyValue: e.target.value }))}
                  aria-invalid={invalidField === 'every' ? 'true' : undefined}
                  className={cn(inputClass, 'h-[34px] font-mono tabular-nums')}
                />
              </div>
              <div className="grid content-start gap-[5px]">
                <label htmlFor={unitInputId} className="text-[12.5px] font-medium text-foreground/78">
                  {t('editor.unitLabel')}
                </label>
                <select
                  id={unitInputId}
                  value={form.everyUnit}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, everyUnit: e.target.value as 'minutes' | 'hours' }))
                  }
                  className={cn(inputClass, 'h-[34px] bg-[#212124]')}
                >
                  <option value="minutes">{t('editor.unitMinutes')}</option>
                  <option value="hours">{t('editor.unitHours')}</option>
                </select>
              </div>
            </div>
            <span className="text-[11.5px] text-[rgba(154,149,140,0.58)]">{t('editor.intervalHint')}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1 text-[11.5px] text-[rgba(154,149,140,0.58)]">
          <span>{t('editor.nextPreview')}</span>
          {previewDates.length === 0 ? (
            <span>—</span>
          ) : (
            previewDates.map((d) => {
              const ts = d.getTime()
              return (
                <span
                  key={ts}
                  className="inline-flex items-center rounded-[5px] bg-white/[0.06] px-[6px] py-[1px] font-mono text-[11px] text-foreground/85"
                >
                  {formatUpcomingDay(ts, Date.now(), tr)} {formatHHMM(ts)}
                </span>
              )
            })
          )}
        </div>

        <fieldset className="m-0 grid gap-1.5 border-0 p-0">
          <legend className="mb-1.5 text-[12.5px] font-medium text-foreground/78">{t('editor.missedLegend')}</legend>
          <div className="routine-seg" role="radiogroup" aria-label={t('editor.missedLegend')}>
            {(
              [
                ['catchup', 'editor.missedCatchup', 'editor.missedCatchupSub'],
                ['skip', 'editor.missedSkip', 'editor.missedSkipSub'],
              ] as const
            ).map(([policy, labelKey, subKey]) => (
              <button
                key={policy}
                type="button"
                role="radio"
                aria-checked={form.missed === policy}
                onClick={() => setForm((prev) => ({ ...prev, missed: policy as RoutineMissed }))}
                className="routine-choice"
              >
                <span>
                  {t(labelKey)}
                  <small>{t(subKey)}</small>
                </span>
                <span className="routine-mark" />
              </button>
            ))}
          </div>
        </fieldset>

        <div className="h-px bg-border" />

        <fieldset className="m-0 grid gap-1.5 border-0 p-0">
          <legend className="mb-1.5 text-[12.5px] font-medium text-foreground/78">{t('editor.permissionsLegend')}</legend>
          <div className="grid gap-1" role="radiogroup" aria-label={t('editor.permissionsLegend')}>
            {PERM_OPTIONS.map((mode) => {
              const Icon = mode === 'ask' ? Hand : mode === 'full' ? ShieldAlert : TerminalSquare
              const labelKey = mode === 'ask' ? 'perm.askLabel' : mode === 'full' ? 'perm.fullLabel' : 'perm.autoLabel'
              const descKey = mode === 'ask' ? 'perm.askDesc' : mode === 'full' ? 'perm.fullDesc' : 'perm.autoDesc'
              const checked = form.permMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setForm((prev) => ({ ...prev, permMode: mode }))}
                  className={cn('routine-choice items-start justify-start gap-[11px]', `perm-${mode}`)}
                >
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 size-[15px] shrink-0',
                      mode === 'full'
                        ? 'text-[var(--artifact-warn)]'
                        : checked
                          ? 'text-foreground'
                          : 'text-muted-foreground'
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <b
                      className={cn(
                        'block font-medium',
                        mode === 'full' ? 'text-[var(--artifact-warn)]' : 'text-foreground'
                      )}
                    >
                      {tChat(labelKey)}
                    </b>
                    <small>{tChat(descKey)}</small>
                  </span>
                  <span className="routine-mark mt-0.5" />
                </button>
              )
            })}
          </div>
          <div className={cn('routine-mode-note', form.permMode === 'full' && 'risk')}>
            {form.permMode === 'full' ? (
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[var(--artifact-warn)]" />
            ) : (
              <Clock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[rgba(154,149,140,0.58)]" />
            )}
            <span>{t(`permMode.${form.permMode}Routine` as never)}</span>
          </div>

          {target.kind === 'edit' && form.permMode !== 'full' && savedPermissions.length > 0 && (
            <div className="mt-1 grid gap-[5px]">
              <span className="text-[11.5px] text-[rgba(154,149,140,0.58)]">{t('editor.alwaysAllowedLabel')}</span>
              <ul className="m-0 flex list-none flex-wrap gap-[5px] p-0">
                {savedPermissions.map((perm) => (
                  <li
                    key={perm.id}
                    className="inline-flex items-center gap-1 rounded-[7px] border border-border py-0.5 pl-2 pr-0.5 text-[12px]"
                  >
                    <RoutineSavedPermissionLabel perm={perm} />
                    <button
                      type="button"
                      aria-label={t('detail.removePermissionAria', { resource: perm.resource })}
                      title={t('detail.removePermissionTitle')}
                      onClick={() => void onRemoveSavedPermission(target.routine.id, perm.id)}
                      className="grid size-[22px] place-items-center rounded-[5px] text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                    >
                      <X aria-hidden="true" className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>

        <div className="grid content-start gap-[5px]">
          <span id={modelLabelId} className="text-[12.5px] font-medium text-foreground/78">
            {t('editor.modelLabel')}
          </span>
          <div
            role="group"
            aria-labelledby={modelLabelId}
            className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-[8px] border border-border bg-black/20 p-1.5"
          >
            <ChatModelChip
              value={selection}
              avoidOverflow
              onSelect={(next) => {
                setMeta(null)
                setForm((prev) => ({
                  ...prev,
                  model: {
                    ...prev.model,
                    providerId: next.providerId,
                    modelId: next.modelId,
                  },
                }))
              }}
            />
            {metaReady && efforts.length > 0 && (
              <ChatReasoningPicker
                value={(form.model.reasoning ?? 'off') as ChatReasoningEffort}
                efforts={efforts}
                nativeUltraMode={currentMeta?.nativeUltraMode === true}
                avoidOverflow
                onChange={(effort) =>
                  setForm((prev) => ({
                    ...prev,
                    model: { ...prev.model, reasoning: effort },
                  }))
                }
              />
            )}
            {metaReady && fastAvailable && (
              <FastModeChip
                enabled={Boolean(form.model.fastMode)}
                onToggle={() =>
                  setForm((prev) => ({
                    ...prev,
                    model: { ...prev.model, fastMode: !prev.model.fastMode },
                  }))
                }
              />
            )}
            {selection && !metaReady && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          <span className="text-[11.5px] text-[rgba(154,149,140,0.58)]">
            {target.originTitle ? t('editor.modelHintOrigin', { title: target.originTitle }) : ''}
            {t('editor.modelHintAll')}
          </span>
        </div>

        <div className="h-px bg-border" />

        <div className="grid grid-cols-2 gap-2.5 max-[560px]:grid-cols-1">
          <div className="grid content-start gap-[5px]">
            <label htmlFor={notifyInputId} className="text-[12.5px] font-medium text-foreground/78">
              {t('editor.notifyLabel')}
            </label>
            <select
              id={notifyInputId}
              value={form.notify}
              onChange={(e) => setForm((prev) => ({ ...prev, notify: e.target.value as RoutineNotify }))}
              className={cn(inputClass, 'h-[34px] bg-[#212124]')}
            >
              <option value="notable">{t('schedule.notifyNotable')}</option>
              <option value="all">{t('schedule.notifyAll')}</option>
              <option value="none">{t('schedule.notifyNone')}</option>
            </select>
            <span className="text-[11.5px] text-[rgba(154,149,140,0.58)]">{t('editor.notifyHint')}</span>
          </div>

          <div className="grid content-start gap-[5px]">
            <label htmlFor={retentionInputId} className="text-[12.5px] font-medium text-foreground/78">
              {t('editor.retentionLabel')}
            </label>
            <select
              id={retentionInputId}
              value={String(form.retentionDays)}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, retentionDays: Number(e.target.value) as RoutineRetentionDays }))
              }
              className={cn(inputClass, 'h-[34px] bg-[#212124]')}
            >
              {[30, 60, 90, 0].map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? t('editor.retentionAlways') : t('editor.retentionDays', { count: days })}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-[18px] pb-4 pt-3">
        {activeError ? (
          <span role="alert" className="mr-auto text-[12px] text-[var(--artifact-err)]">
            {activeError}
          </span>
        ) : (
          <span className="mr-auto" />
        )}
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="inline-flex h-[30px] items-center justify-center rounded-[8px] border border-border-strong px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-white/[0.06] disabled:opacity-50"
        >
          {t('editor.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={saving}
          className="inline-flex h-[30px] items-center justify-center gap-1.5 rounded-[8px] border border-transparent bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          <span>{target.kind === 'edit' ? t('editor.save') : t('editor.create')}</span>
        </button>
      </div>
    </>
  )
}

export function RoutineEditorDialog({
  target,
  savedPermissions = [],
  onClose,
  onSaveNew,
  onSaveEdit,
  onRemoveSavedPermission,
}: {
  target: RoutineEditorTarget | null
  savedPermissions?: readonly RoutineSavedPermission[]
  onClose: () => void
  onSaveNew: (draft: RoutineDraft, sourceConversationId?: string) => Promise<void>
  onSaveEdit: (routineId: string, patch: RoutineUpdatePatch) => Promise<void>
  onRemoveSavedPermission: (routineId: string, permId: string) => Promise<void> | void
}) {
  const { t } = useTranslation('routines')
  const heading =
    target?.kind === 'edit'
      ? t('editor.editTitle')
      : target?.kind === 'proposal'
        ? t('editor.proposalTitle')
        : t('editor.newTitle')

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showClose={false}
        className="flex max-h-[calc(100dvh-48px)] w-[min(600px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-[14px] border border-border-strong bg-[#1b1b1e] p-0 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
      >
        <DialogTitle className="sr-only">{heading}</DialogTitle>
        <DialogDescription className="sr-only">{t('editor.subtitleBase')}</DialogDescription>
        {target && (
          <RoutineEditorFormBody
            target={target}
            savedPermissions={savedPermissions}
            onClose={onClose}
            onSaveNew={onSaveNew}
            onSaveEdit={onSaveEdit}
            onRemoveSavedPermission={onRemoveSavedPermission}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
