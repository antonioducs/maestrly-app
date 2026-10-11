import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SkillsSettings } from '@/components/chat/SkillsSettings'
import { createEnvironmentSkillsSource, type EnvironmentSkillDetail } from '@/components/chat/skills-settings-source'
import { useEnvironmentSettingsSource, useSettingsLifetime } from '@/lib/fleet/environment-settings'
import {
  SaveDiscard,
  SettingsPanel,
  settingsInput,
  useSettingsDraft,
  type EnvironmentSettingsSectionProps,
} from './shared'
export function EnvironmentSkills(props: EnvironmentSettingsSectionProps) {
  const { t } = useTranslation('fleet')
  const [confirmation, setConfirmation] = useState<{
    message: string
    kind: 'remove' | 'replace'
    finish: (confirmed: boolean) => void
  } | null>(null)
  const pending = useRef<((confirmed: boolean) => void) | null>(null)
  const confirmAction = useCallback(
    (message: string, kind: 'remove' | 'replace' = 'remove') =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false)
        pending.current = resolve
        setConfirmation({ message, kind, finish: resolve })
      }),
    []
  )
  useEffect(
    () => () => {
      pending.current?.(false)
    },
    []
  )
  const api = useEnvironmentSettingsSource(props.environment.id)
  const source = useMemo(() => createEnvironmentSkillsSource(api), [api])
  return (
    <SettingsPanel>
      <SkillsSettings
        key={props.environment.id}
        source={source}
        confirmAction={confirmAction}
        onDirtyChange={props.onDirtyChange}
        renderDetail={(detail, close) => (
          <SkillEditor
            key={detail.name}
            {...props}
            detail={detail as EnvironmentSkillDetail}
            close={() => {
              source.notifyChanged()
              close()
            }}
          />
        )}
      />
      {confirmation && (
        <ConfirmDialog
          title={t(confirmation.kind === 'replace' ? 'environmentSettingsShell.replace' : 'environmentSettings.remove')}
          message={confirmation.message}
          confirmLabel={t(
            confirmation.kind === 'replace' ? 'environmentSettingsShell.replace' : 'environmentSettings.remove'
          )}
          destructive
          onCancel={() => {
            confirmation.finish(false)
            setConfirmation(null)
          }}
          onConfirm={() => {
            confirmation.finish(true)
            setConfirmation(null)
          }}
        />
      )}
    </SettingsPanel>
  )
}
function SkillEditor({
  environment,
  detail,
  onDirtyChange,
  close,
}: EnvironmentSettingsSectionProps & { detail: EnvironmentSkillDetail; close: () => void }) {
  const { t } = useTranslation('fleet')
  const source = useEnvironmentSettingsSource(environment.id)
  const revision = useRef(detail.revision)
  const [latest, setLatest] = useState(detail)
  const lifetime = useSettingsLifetime()
  const refreshing = useRef(false)
  const editor = useSettingsDraft(
    latest.body,
    async (markdown) => {
      const updated = await source.writeSkill({ name: detail.name, expectedRevision: revision.current, markdown })
      revision.current = updated.revision
      setLatest((value) => ({ ...value, ...updated, body: updated.markdown }))
    },
    onDirtyChange,
    latest.revision
  )
  useEffect(() => {
    if (!editor.dirty) revision.current = latest.revision
  }, [latest.revision, editor.dirty])
  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    const epoch = lifetime.current
    try {
      const updated = await source.skill({ name: detail.name })
      if (epoch === lifetime.current) setLatest((value) => ({ ...value, ...updated, body: updated.markdown }))
    } finally {
      refreshing.current = false
    }
  }, [source, detail.name, lifetime])
  useEffect(() => {
    const focus = () => {
      if (navigator.onLine && document.visibilityState === 'visible') void refresh().catch(() => {})
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [refresh])
  const discard = () => {
    editor.discard()
    onDirtyChange?.(
      false,
      async () => true,
      () => {}
    )
    close()
  }
  return (
    <SettingsPanel
      error={editor.error}
      reload={() => {
        void source
          .skill({ name: detail.name })
          .then((updated) => {
            revision.current = updated.revision
            setLatest((value) => ({ ...value, ...updated, body: updated.markdown }))
            editor.reset(updated.markdown)
          })
          .catch(() => {})
      }}
    >
      <h3 className="text-xs font-medium">{detail.name}</h3>
      <textarea
        className={`${settingsInput} min-h-64 font-mono text-xs`}
        aria-label={t('environmentSettings.markdown')}
        value={editor.draft}
        readOnly={!latest.editable}
        disabled={editor.busy}
        onChange={(e) => editor.setDraft(e.target.value)}
        spellCheck={false}
      />
      {!latest.editable && <p className="text-xs text-muted-foreground">{t('environmentSettings.skillReadOnly')}</p>}
      {latest.editable && <SaveDiscard {...editor} />}
      <Button size="sm" variant="ghost" disabled={editor.busy || editor.dirty} onClick={discard}>
        {t('environmentSettings.close')}
      </Button>
    </SettingsPanel>
  )
}
