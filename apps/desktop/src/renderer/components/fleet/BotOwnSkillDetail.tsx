import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowLeft, Lock, LockOpen, Plus, Trash2 } from 'lucide-react'
import {
  FLEET_BOT_OWN_SKILL_LIMITS,
  fleetBotOwnSkillPathSchema,
  type FleetBotOwnSkillAction,
  type FleetBotOwnSkillDetail,
  type FleetBotOwnSkillFile,
} from '@maestrly/bot-fleet-protocol'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { fleetErrorText } from '@/lib/fleet/errors'
import { useFleetServerId } from '@/lib/fleet/server-context'
import { cn } from '@/lib/utils'
import { BotOwnSkillBadges } from './BotOwnSkillBadges'
import { BotOwnSkillDiff } from './BotOwnSkillDiff'

type Confirm = { kind: 'delete' } | { kind: 'remove-file'; path: string }

const tabButton =
  'rounded-md px-2 py-1 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** One of the bot's skills: its files, the change waiting for review, its history, and what the owner can do with it. */
export function BotOwnSkillDetail({
  botId,
  name,
  onBack,
  onChanged,
}: {
  botId: string
  name: string
  onBack: () => void
  onChanged: () => void
}) {
  const serverId = useFleetServerId()
  const { t, i18n } = useTranslation('fleet')
  const [skill, setSkill] = useState<FleetBotOwnSkillDetail | null>(null)
  const [path, setPath] = useState('SKILL.md')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newPath, setNewPath] = useState<string | null>(null)
  const [compare, setCompare] = useState<{ versionId: string; files: FleetBotOwnSkillFile[] | null } | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const date = (value: number) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })

  useEffect(() => {
    let alive = true
    window.api.fleetGetBotOwnSkill(serverId, botId, name).then(
      (value) => {
        if (!alive) return
        setSkill(value)
        setError('')
      },
      (cause) => {
        if (alive) setError(fleetErrorText(cause, t))
      }
    )
    return () => {
      alive = false
    }
  }, [serverId, botId, name, t])

  const files = useMemo(() => {
    const current = skill?.currentFiles ?? []
    const extra = Object.keys(drafts)
      .filter((file) => !current.some((item) => item.path === file))
      .map((file) => ({ path: file, content: '' }))
    return [...current, ...extra]
  }, [skill, drafts])
  const file = files.find((item) => item.path === path) ?? files[0]
  const text = file ? (drafts[file.path] ?? file.content) : ''
  const editable = skill?.status === 'active'
  const dirty = Boolean(file && drafts[file.path] !== undefined && drafts[file.path] !== file.content)
  const isNew = Boolean(file && !skill?.currentFiles.some((item) => item.path === file.path))

  /** True once the change took effect. */
  async function act(action: FleetBotOwnSkillAction, done?: string): Promise<boolean> {
    if (busy || !skill) return false
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.fleetActOnBotOwnSkill(serverId, botId, name, action)
      setConfirm(null)
      onChanged()
      if (!result.skill) {
        onBack()
        return true
      }
      setSkill(result.skill)
      if (done) setNotice(done)
      return true
    } catch (cause) {
      setError(fleetErrorText(cause, t))
      return false
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    if (!skill || !file) return
    const saved = await act(
      { action: 'write-file', revision: skill.revision, path: file.path, content: text },
      t('ownSkills.saved')
    )
    if (!saved) return
    setDrafts((value) => {
      const next = { ...value }
      delete next[file.path]
      return next
    })
  }
  function addFile() {
    const value = (newPath ?? '').trim()
    if (!fleetBotOwnSkillPathSchema.safeParse(value).success || value === 'SKILL.md') {
      setError(t('ownSkills.newFileInvalid'))
      return
    }
    if (files.some((item) => item.path === value)) {
      setPath(value)
      setNewPath(null)
      return
    }
    if (files.length >= FLEET_BOT_OWN_SKILL_LIMITS.filesPerSkill) {
      setError(t('ownSkills.tooManyFiles', { max: FLEET_BOT_OWN_SKILL_LIMITS.filesPerSkill }))
      return
    }
    setError('')
    setDrafts((current) => ({ ...current, [value]: '' }))
    setPath(value)
    setNewPath(null)
  }
  async function openCompare(versionId: string) {
    if (compare?.versionId === versionId) {
      setCompare(null)
      return
    }
    setCompare({ versionId, files: null })
    try {
      const version = await window.api.fleetGetBotOwnSkillVersion(serverId, botId, name, versionId)
      setCompare((value) => (value?.versionId === versionId ? { versionId, files: version.files } : value))
    } catch (cause) {
      setCompare(null)
      setError(fleetErrorText(cause, t))
    }
  }

  if (!skill)
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} />
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground">{t('ownSkills.loading')}</p>
        )}
      </div>
    )

  const proposalFiles = skill.proposalFiles
  return (
    <div className="flex flex-col gap-5" data-testid="bot-own-skill-detail">
      <div className="flex flex-col gap-2">
        <BackButton onBack={onBack} />
        <h3 className="font-mono text-[15px] font-medium">{skill.name}</h3>
        {skill.description && <p className="text-[13px] text-foreground/75">{skill.description}</p>}
        <BotOwnSkillBadges skill={skill} />
        <p className="text-xs text-muted-foreground">
          {t('ownSkills.meta', { created: date(skill.createdAt), updated: date(skill.updatedAt) })}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {skill.status !== 'proposed' && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act({ action: skill.locked ? 'unlock' : 'lock', revision: skill.revision })}
            >
              {skill.locked ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}
              {t(skill.locked ? 'ownSkills.unlock' : 'ownSkills.lock')}
            </Button>
          )}
          {skill.status !== 'proposed' && !proposalFiles && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act({ action: skill.status === 'archived' ? 'restore' : 'archive', revision: skill.revision })
              }
            >
              {t(skill.status === 'archived' ? 'ownSkills.restore' : 'ownSkills.archive')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => setConfirm({ kind: 'delete' })}
          >
            <Trash2 aria-hidden="true" />
            {t('ownSkills.delete')}
          </Button>
        </div>
        {skill.locked && <p className="text-xs text-muted-foreground">{t('ownSkills.lockedNote')}</p>}
      </div>

      {proposalFiles && skill.proposal && (
        <section
          aria-labelledby="own-skill-proposal"
          className="flex flex-col gap-3 rounded-xl border border-amber-300/35 bg-amber-300/[0.06] p-4"
        >
          <h4 id="own-skill-proposal" className="text-[13.5px] font-medium">
            {t(skill.status === 'proposed' ? 'ownSkills.proposal.newHeading' : 'ownSkills.proposal.heading')}
          </h4>
          <p className="text-[13px] text-foreground/75">
            {t(`ownSkills.proposal.from.${skill.proposal.actor}`, { date: date(skill.proposal.updatedAt) })}
            {skill.proposal.reason && <> — {skill.proposal.reason}</>}
          </p>
          {skill.status !== 'proposed' && skill.proposal.baseRevision !== skill.revision && (
            <p className="text-xs text-muted-foreground">{t('ownSkills.proposal.stale')}</p>
          )}
          <BotOwnSkillDiff before={skill.currentFiles} after={proposalFiles} />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void act({ action: 'approve', revision: skill.revision })}>
              {t('ownSkills.proposal.approve')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void act({ action: 'discard', revision: skill.revision })}
            >
              {t('ownSkills.proposal.discard')}
            </Button>
          </div>
        </section>
      )}

      {skill.status !== 'proposed' && (
        <section aria-labelledby="own-skill-files" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="own-skill-files" className="text-[13.5px] font-medium">
              {t('ownSkills.files')}
            </h4>
            {editable && newPath === null && (
              <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => setNewPath('')}>
                <Plus aria-hidden="true" />
                {t('ownSkills.newFile')}
              </Button>
            )}
          </div>
          {newPath !== null && (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                addFile()
              }}
            >
              <Input
                autoFocus
                value={newPath}
                aria-label={t('ownSkills.newFilePath')}
                placeholder="scripts/render.sh"
                className="h-8 font-mono text-xs"
                onChange={(event) => setNewPath(event.target.value)}
              />
              <Button size="sm" type="submit">
                {t('ownSkills.addFile')}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setNewPath(null)}>
                {t('ownSkills.cancel')}
              </Button>
            </form>
          )}
          <div role="group" aria-label={t('ownSkills.files')} className="flex flex-wrap gap-1">
            {files.map((item) => (
              <button
                key={item.path}
                type="button"
                aria-pressed={item.path === file?.path}
                onClick={() => setPath(item.path)}
                className={cn(
                  tabButton,
                  item.path === file?.path
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                )}
              >
                {item.path}
                {drafts[item.path] !== undefined && drafts[item.path] !== item.content ? ' •' : ''}
              </button>
            ))}
          </div>
          {file?.path.startsWith('scripts/') && (
            <p
              role="note"
              className="flex items-start gap-2 rounded-lg border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-xs"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />
              {t('ownSkills.scriptWarning')}
            </p>
          )}
          {file && (
            <textarea
              aria-label={t('ownSkills.editorLabel', { path: file.path })}
              value={text}
              readOnly={!editable}
              spellCheck={false}
              onChange={(event) => {
                const value = event.target.value
                setDrafts((current) => ({ ...current, [file.path]: value }))
                setNotice('')
              }}
              className="min-h-[260px] w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-[12.5px] leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring read-only:opacity-75"
            />
          )}
          {editable ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy || !(dirty || isNew)} onClick={() => void save()}>
                {t('ownSkills.save')}
              </Button>
              {(dirty || isNew) && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setDrafts((current) => {
                      const next = { ...current }
                      if (file) delete next[file.path]
                      return next
                    })
                  }
                >
                  {t('ownSkills.revertDraft')}
                </Button>
              )}
              {file && file.path !== 'SKILL.md' && !isNew && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: 'remove-file', path: file.path })}
                >
                  {t('ownSkills.removeFile')}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('ownSkills.archivedReadOnly')}</p>
          )}
        </section>
      )}

      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {skill.versions.length > 0 && (
        <section aria-labelledby="own-skill-history" className="flex flex-col gap-2">
          <h4 id="own-skill-history" className="text-[13.5px] font-medium">
            {t('ownSkills.history')}
          </h4>
          <ol className="divide-y divide-border rounded-xl border border-border bg-foreground/[0.025]">
            {skill.versions.map((version, index) => (
              <li key={version.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                  <span>{t(`ownSkills.versionAction.${version.action}`)}</span>
                  <span className="text-muted-foreground">
                    {t(`ownSkills.by.${version.actor}`)} · {date(version.at)}
                  </span>
                  {index === 0 && (
                    <span className="rounded border border-border px-1.5 text-xs text-muted-foreground">
                      {t('ownSkills.current')}
                    </span>
                  )}
                  {index > 0 && (
                    <span className="ml-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={compare?.versionId === version.id}
                        onClick={() => void openCompare(version.id)}
                      >
                        {t('ownSkills.compare')}
                      </Button>
                      {skill.status === 'active' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              { action: 'revert', revision: skill.revision, versionId: version.id },
                              t('ownSkills.reverted')
                            )
                          }
                        >
                          {t('ownSkills.revertTo')}
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                {version.reason && <p className="text-xs text-foreground/70">{version.reason}</p>}
                {compare?.versionId === version.id &&
                  (compare.files ? (
                    <div className="flex flex-col gap-1.5">
                      <p className="text-xs text-muted-foreground">{t('ownSkills.compareNote')}</p>
                      <BotOwnSkillDiff before={compare.files} after={skill.currentFiles} />
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('ownSkills.loading')}</p>
                  ))}
              </li>
            ))}
          </ol>
        </section>
      )}

      {confirm && (
        <ConfirmDialog
          title={
            confirm.kind === 'delete'
              ? t('ownSkills.deleteConfirm', { name: skill.name })
              : t('ownSkills.removeFileConfirm', { path: confirm.path })
          }
          message={confirm.kind === 'delete' ? t('ownSkills.deleteNote') : t('ownSkills.removeFileNote')}
          confirmLabel={confirm.kind === 'delete' ? t('ownSkills.delete') : t('ownSkills.removeFile')}
          destructive
          busy={busy}
          onCancel={() => {
            if (!busy) setConfirm(null)
          }}
          onConfirm={() =>
            void act(
              confirm.kind === 'delete'
                ? { action: 'delete', revision: skill.revision }
                : { action: 'remove-file', revision: skill.revision, path: confirm.path }
            ).then((done) => {
              if (done && confirm.kind === 'remove-file') setPath('SKILL.md')
            })
          }
        />
      )}
    </div>
  )
}

function BackButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('fleet')
  return (
    <Button size="sm" variant="ghost" className="-ml-2 self-start" onClick={onBack}>
      <ArrowLeft aria-hidden="true" />
      {t('ownSkills.back')}
    </Button>
  )
}
