import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, MessageSquarePlus, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Conversation, ReviewLoopInfo } from '../../../preload'
import {
  DEFAULT_REASONING_EFFORTS,
  isChatProviderConnected,
  reasoningPickerUltraState,
  type ChatConfig,
  type ChatModelMeta,
  type ChatReasoningEffort,
} from '../../../shared/chat'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SearchSelect } from '@/components/ui/search-select'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

interface Props {
  executor: Conversation | null
  open: boolean
  onOpenChange(open: boolean): void
  onStarted(loop: ReviewLoopInfo): void
  onReviewerCreated(conversation: Conversation): void | Promise<void>
}

export function ReviewLoopPickerDialog({ executor, open, onOpenChange, onStarted, onReviewerCreated }: Props) {
  const { t } = useTranslation('chat')
  const generationRef = useRef(0)
  const [config, setConfig] = useState<ChatConfig | null>(null)
  const [providerId, setProviderId] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelId, setModelId] = useState('')
  const [modelMeta, setModelMeta] = useState<ChatModelMeta | null>(null)
  const [reasoning, setReasoning] = useState<ChatReasoningEffort>('off')
  const [fastMode, setFastMode] = useState(false)
  const [reviewerName, setReviewerName] = useState('')
  const [reviewer, setReviewer] = useState<Conversation | null>(null)
  const [maxIterations, setMaxIterations] = useState(5)
  const [threshold, setThreshold] = useState<'blocking' | 'important'>('important')
  const [loadingConfig, setLoadingConfig] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [loadingMeta, setLoadingMeta] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connectedProviders = useMemo(() => config?.providers.filter(isChatProviderConnected) ?? [], [config])

  const loadProviderModels = async (nextProviderId: string, preferredModelId?: string) => {
    const generation = ++generationRef.current
    setProviderId(nextProviderId)
    setModels([])
    setModelId('')
    setModelMeta(null)
    setLoadingMeta(false)
    setReasoning('off')
    setFastMode(false)
    setLoadingModels(true)
    try {
      const nextModels = await window.api.chatModels(nextProviderId)
      if (generationRef.current !== generation) return
      setModels(nextModels)
      setModelId(preferredModelId && nextModels.includes(preferredModelId) ? preferredModelId : (nextModels[0] ?? ''))
    } catch (reason) {
      if (generationRef.current === generation) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (generationRef.current === generation) setLoadingModels(false)
    }
  }

  useEffect(() => {
    if (!open || !executor) return
    generationRef.current++
    setConfig(null)
    setProviderId('')
    setModels([])
    setModelId('')
    setModelMeta(null)
    setLoadingMeta(false)
    setReasoning('off')
    setFastMode(false)
    setReviewer(null)
    setReviewerName(`${executor.name} · Reviewer`)
    setMaxIterations(5)
    setThreshold('important')
    setError(null)
    setLoadingConfig(true)
    let alive = true
    void window.api
      .chatConfig()
      .then(async (nextConfig) => {
        if (!alive) return
        setConfig(nextConfig)
        const connected = nextConfig.providers.filter(isChatProviderConnected)
        const preferred = nextConfig.defaultSelection
        const provider =
          (preferred && connected.find((candidate) => candidate.id === preferred.providerId)) ?? connected[0]
        if (!provider) return
        await loadProviderModels(provider.id, preferred?.providerId === provider.id ? preferred.modelId : undefined)
        if (alive) setReasoning(nextConfig.defaultReasoning || 'off')
      })
      .catch((reason) => alive && setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => alive && setLoadingConfig(false))
    return () => {
      alive = false
      generationRef.current++
    }
  }, [executor, open])

  useEffect(() => {
    if (!providerId || !modelId) {
      setModelMeta(null)
      setLoadingMeta(false)
      return
    }
    let alive = true
    setLoadingMeta(true)
    void window.api
      .chatModelMeta(modelId, providerId)
      .then((meta) => {
        if (!alive) return
        setModelMeta(meta)
        if (meta?.fastModeCapability !== true) setFastMode(false)
      })
      .catch(() => alive && setModelMeta(null))
      .finally(() => alive && setLoadingMeta(false))
    return () => {
      alive = false
    }
  }, [modelId, providerId])

  const supportedEfforts = useMemo(
    () =>
      modelMeta?.reasoning
        ? modelMeta.reasoningEfforts?.length
          ? modelMeta.reasoningEfforts
          : [...DEFAULT_REASONING_EFFORTS]
        : [],
    [modelMeta]
  )
  const effortProfile = useMemo(
    () => reasoningPickerUltraState(supportedEfforts, modelMeta?.nativeUltraMode === true),
    [modelMeta?.nativeUltraMode, supportedEfforts]
  )

  useEffect(() => {
    if (!modelMeta) return
    if (!modelMeta.reasoning) {
      setReasoning('off')
      return
    }
    const allowed = new Set<ChatReasoningEffort>(['off', ...effortProfile.regularEfforts, effortProfile.ultraValue])
    setReasoning((current) => (allowed.has(current) ? current : 'off'))
  }, [effortProfile, modelMeta])

  const createAndStart = async () => {
    if (!executor || !providerId || !modelId || starting) return
    setStarting(true)
    setError(null)
    try {
      let target = reviewer
      if (!target) {
        target = await window.api.createSiblingConversation({ sourceConversationId: executor.id })
        setReviewer(target)
      }
      const name = reviewerName.trim() || `${executor.name} · Reviewer`
      if (target.name !== name) {
        await window.api.renameConversation(target.id, name)
        target = { ...target, name }
        setReviewer(target)
      }
      await onReviewerCreated(target)

      const selected = await window.api.chatSetSelection(target.id, { providerId, modelId })
      if (!selected.ok) throw new Error(selected.error || 'reviewer-model-unavailable')
      const effortSaved = await window.api.chatSetReasoning(target.id, reasoning)
      if (!effortSaved.ok) throw new Error('reviewer-reasoning-unavailable')
      const fastSaved = await window.api.chatSetFastMode(target.id, modelMeta?.fastModeCapability === true && fastMode)
      if (!fastSaved.ok) throw new Error('reviewer-fast-mode-unavailable')
      const modeSaved = await window.api.chatSetMode(target.id, 'agent')
      if (!modeSaved.ok) throw new Error('reviewer-mode-unavailable')

      const result = await window.api.chatReviewLoopStart({
        executorConversationId: executor.id,
        reviewerConversationId: target.id,
        maxIterations,
        severityThreshold: threshold,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      onStarted(result.loop)
      onOpenChange(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStarting(false)
    }
  }

  const close = (next: boolean) => {
    if (!starting) onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('reviewLoop.pickerTitle')}</DialogTitle>
          <DialogDescription>{t('reviewLoop.pickerDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="review-loop-reviewer-name">{t('reviewLoop.pickerReviewerName')}</Label>
            <Input
              id="review-loop-reviewer-name"
              value={reviewerName}
              onChange={(event) => setReviewerName(event.target.value)}
              disabled={starting || reviewer != null}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('reviewLoop.pickerProvider')}</Label>
              <Select
                value={providerId}
                onValueChange={(value) => void loadProviderModels(value)}
                disabled={loadingConfig || starting}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('reviewLoop.pickerProviderPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {connectedProviders.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t('reviewLoop.pickerModel')}</Label>
              {loadingModels ? (
                <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> {t('modelChip.loading')}
                </div>
              ) : (
                <SearchSelect
                  value={modelId || undefined}
                  options={models.map((model) => ({ id: model, label: model }))}
                  onChange={(value) => setModelId(value ?? '')}
                  placeholder={t('modelChip.typeManually')}
                  allowCustom
                  customLabel={(value) => t('modelChip.useAsId', { query: value })}
                  invalid={!modelId}
                  disabled={!providerId || starting}
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('reviewLoop.pickerReasoning')}</Label>
              <Select value={reasoning} onValueChange={setReasoning} disabled={!modelMeta?.reasoning || starting}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('reasoning.default')}</SelectItem>
                  {effortProfile.regularEfforts.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort}
                    </SelectItem>
                  ))}
                  {modelMeta?.reasoning && (
                    <SelectItem value={effortProfile.ultraValue}>
                      {effortProfile.unifiedNativeUltra ? t('reasoning.ultra') : t('reasoning.maestrlyUltra')}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('reviewLoop.pickerFast')}</Label>
              <button
                type="button"
                aria-pressed={fastMode}
                onClick={() => setFastMode((value) => !value)}
                disabled={modelMeta?.fastModeCapability !== true || starting}
                className={cn(
                  'flex h-9 w-full items-center justify-center gap-1.5 rounded-md border text-xs transition-colors disabled:opacity-45',
                  fastMode ? 'border-amber-400/30 bg-amber-500/10 text-amber-300' : 'text-muted-foreground'
                )}
              >
                <Zap className={cn('size-3.5', fastMode && 'fill-current')} />
                {fastMode ? t('reviewLoop.pickerFastOn') : t('reviewLoop.pickerFastOff')}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="review-loop-max">{t('reviewLoop.pickerMaxIterations')}</Label>
              <Input
                id="review-loop-max"
                type="number"
                min={1}
                max={10}
                value={maxIterations}
                onChange={(event) => setMaxIterations(Math.min(10, Math.max(1, Number(event.target.value) || 1)))}
                disabled={starting}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('reviewLoop.pickerThreshold')}</Label>
              <Select
                value={threshold}
                onValueChange={(value) => setThreshold(value as typeof threshold)}
                disabled={starting}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="important">{t('reviewLoop.thresholdImportant')}</SelectItem>
                  <SelectItem value="blocking">{t('reviewLoop.thresholdBlocking')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {connectedProviders.length === 0 && !loadingConfig && (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              {t('modelChip.noProviders')}
            </p>
          )}
          {reviewer && error && (
            <p className="text-xs text-muted-foreground">
              {t('reviewLoop.pickerCreatedRetry', { name: reviewer.name })}
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={starting}>
            {t('reviewLoop.pickerCancel')}
          </Button>
          <Button
            onClick={() => void createAndStart()}
            disabled={!executor || !providerId || !modelId || loadingConfig || loadingModels || loadingMeta || starting}
          >
            {starting ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <MessageSquarePlus className="mr-1.5 size-4" />
            )}
            {starting ? t('reviewLoop.pickerStarting') : t('reviewLoop.pickerCreateAndStart')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
