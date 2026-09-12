import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FolderOpen,
  Layers3,
  Loader2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatSkillDetail, ChatSkillGroup, ChatSkillSearchHit, ChatSkillsState } from '../../../shared/chat'

const inputCls =
  'rounded-md border border-border bg-black/20 px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-indigo-500/60'

const SKILLS_TABS = ['all', 'groups', 'library'] as const
type SkillsTab = (typeof SKILLS_TABS)[number]

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors', on ? 'bg-emerald-500/70' : 'bg-white/10')}
    >
      <span className={cn('block h-3 w-3 rounded-full bg-white transition-transform', on && 'translate-x-3')} />
    </button>
  )
}

function SkillDetailPanel({ detail, onClose }: { detail: ChatSkillDetail; onClose: () => void }) {
  const { t } = useTranslation('chat')
  return (
    <div className="rounded-lg border border-border bg-black/20 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[13px] text-foreground">/{detail.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{detail.source}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          title={t('settings.skillClose')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {t('settings.skillFilesHeading')}
      </div>
      {detail.files.length ? (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {detail.files.map((file) => (
            <li
              key={file}
              className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              {file}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[11px] text-muted-foreground">{t('settings.skillNoFiles')}</p>
      )}
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
        {detail.body}
      </pre>
    </div>
  )
}

export function SkillsSettings() {
  const { t } = useTranslation('chat')
  const [state, setState] = useState<ChatSkillsState>({
    skills: [],
    groups: [],
    selection: { kind: 'all' },
    selectedGroupMissing: false,
    hasOverrides: false,
  })
  const [tab, setTab] = useState<SkillsTab>('all')
  const [detail, setDetail] = useState<ChatSkillDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ChatSkillSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [slug, setSlug] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupDescription, setGroupDescription] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string; description: string } | null>(null)
  const [membershipEditor, setMembershipEditor] = useState<string | null>(null)
  const [membershipQuery, setMembershipQuery] = useState('')
  const [skillGroupPicker, setSkillGroupPicker] = useState<string | null>(null)
  const tabsId = useId()
  const tabRefs = useRef<Record<SkillsTab, HTMLButtonElement | null>>({ all: null, groups: null, library: null })
  const groupMutations = useRef(new Set<string>())
  const searchRequest = useRef(0)
  const [busyGroups, setBusyGroups] = useState<Set<string>>(new Set())

  const refresh = (): Promise<void> => window.api.chatSkillsState().then(setState)
  const notifyChanged = () => window.dispatchEvent(new Event('maestrly:skills-changed'))
  useEffect(() => {
    void refresh()
    const onChanged = () => void refresh()
    window.addEventListener('maestrly:skills-changed', onChanged)
    return () => window.removeEventListener('maestrly:skills-changed', onChanged)
  }, [])

  const finishMutation = async (): Promise<void> => {
    await refresh()
    notifyChanged()
  }

  const install = async (value: string, overwrite: boolean): Promise<void> => {
    if (!value.trim()) return
    setBusy(value)
    setError('')
    let res: Awaited<ReturnType<typeof window.api.chatSkillInstall>>
    try {
      res = await window.api.chatSkillInstall({ slug: value, overwrite })
    } catch (cause) {
      setError(t('settings.skillErrInstall', { error: cause instanceof Error ? cause.message : String(cause) }))
      return
    } finally {
      setBusy(null)
    }
    if (!res.ok) {
      if (res.error === 'already-exists' && !overwrite) {
        if (confirm(t('settings.skillOverwriteConfirm', { name: res.name ?? value }))) return install(value, true)
        return
      }
      setError(t('settings.skillErrInstall', { error: res.available?.join(', ') || res.error || '' }))
      return
    }
    setSlug('')
    await finishMutation()
    if (hits) setHits(hits.map((hit) => (hit.slug === value ? { ...hit, installed: true } : hit)))
  }

  const search = async (): Promise<void> => {
    if (!query.trim()) {
      searchRequest.current += 1
      setHits(null)
      return
    }
    const request = ++searchRequest.current
    setSearching(true)
    setError('')
    let res: Awaited<ReturnType<typeof window.api.chatSkillSearch>>
    try {
      res = await window.api.chatSkillSearch(query)
    } catch (cause) {
      if (request !== searchRequest.current) return
      setError(t('settings.skillErrSearch', { error: cause instanceof Error ? cause.message : String(cause) }))
      return
    } finally {
      if (request === searchRequest.current) setSearching(false)
    }
    if (request !== searchRequest.current) return
    if (!res.ok) {
      setError(t('settings.skillErrSearch', { error: res.error ?? '' }))
      return
    }
    setHits(res.hits)
  }

  const create = async (): Promise<void> => {
    setError('')
    const res = await window.api.chatSkillCreate({ name, description })
    if (!res.ok) {
      setError(t('settings.skillErrCreate', { error: res.error ?? '' }))
      return
    }
    setCreating(false)
    setName('')
    setDescription('')
    await finishMutation()
  }

  const createGroup = async (): Promise<void> => {
    setError('')
    const res = await window.api.chatSkillGroupCreate({ name: groupName, description: groupDescription })
    if (!res.ok) {
      setError(t('settings.skillGroupError', { error: res.error ?? '' }))
      return
    }
    setCreatingGroup(false)
    setGroupName('')
    setGroupDescription('')
    if (res.group) setOpenGroups((current) => new Set(current).add(res.group!.id))
    await finishMutation()
  }

  const updateGroup = async (
    group: ChatSkillGroup,
    patch: { name?: string; description?: string; skills?: string[] }
  ): Promise<boolean> => {
    if (groupMutations.current.has(group.id)) return false
    groupMutations.current.add(group.id)
    setBusyGroups((current) => new Set(current).add(group.id))
    setError('')
    try {
      const res = await window.api.chatSkillGroupUpdate(group.id, patch)
      if (!res.ok) {
        setError(t('settings.skillGroupError', { error: res.error ?? '' }))
        return false
      }
      await finishMutation()
      return true
    } catch (cause) {
      setError(t('settings.skillGroupError', { error: cause instanceof Error ? cause.message : String(cause) }))
      return false
    } finally {
      groupMutations.current.delete(group.id)
      setBusyGroups((current) => {
        const next = new Set(current)
        next.delete(group.id)
        return next
      })
    }
  }

  const toggleMembership = (group: ChatSkillGroup, skillName: string): void => {
    const skills = group.skills.includes(skillName)
      ? group.skills.filter((name) => name !== skillName)
      : [...group.skills, skillName]
    void updateGroup(group, { skills })
  }

  const duplicateGroup = (group: ChatSkillGroup): void => {
    const base = `${group.name.slice(0, 60).trim()} ${t('settings.skillGroupCopySuffix')}`
    let name = base
    let suffix = 2
    const existing = new Set(state.groups.map((item) => item.name.toLowerCase()))
    while (existing.has(name.toLowerCase())) name = `${base} ${suffix++}`
    void window.api
      .chatSkillGroupCreate({ name, description: group.description, skills: group.skills })
      .then(async (res) => {
        if (!res.ok) setError(t('settings.skillGroupError', { error: res.error ?? '' }))
        else await finishMutation()
      })
  }

  const removeGroup = (group: ChatSkillGroup): void => {
    if (!confirm(t('settings.skillGroupConfirmRemove', { name: group.name }))) return
    void window.api.chatSkillGroupRemove(group.id).then(async (res) => {
      if (!res.ok) setError(t('settings.skillGroupError', { error: res.error ?? '' }))
      else await finishMutation()
    })
  }

  const availableNames = new Set(state.skills.map((skill) => skill.name))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="text-[12px] font-medium text-foreground">{t('settings.skillsHeading')}</span>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t('settings.skillsDescription')}</p>
        </div>
      </div>

      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label={t('settings.skillsTabsLabel')}
        className="flex w-fit gap-1 rounded-lg bg-white/[0.035] p-1"
      >
        {SKILLS_TABS.map((id) => (
          <button
            key={id}
            ref={(node) => {
              tabRefs.current[id] = node
            }}
            id={`${tabsId}-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`${tabsId}-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event) => {
              const current = SKILLS_TABS.indexOf(id)
              let next: SkillsTab | undefined
              if (event.key === 'ArrowRight') next = SKILLS_TABS[(current + 1) % SKILLS_TABS.length]
              else if (event.key === 'ArrowLeft')
                next = SKILLS_TABS[(current - 1 + SKILLS_TABS.length) % SKILLS_TABS.length]
              else if (event.key === 'Home') next = SKILLS_TABS[0]
              else if (event.key === 'End') next = SKILLS_TABS[SKILLS_TABS.length - 1]
              if (!next) return
              event.preventDefault()
              setTab(next)
              tabRefs.current[next]?.focus()
            }}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px]',
              tab === id ? 'bg-white/[0.1] text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`settings.skillsTab${id === 'all' ? 'All' : id === 'groups' ? 'Groups' : 'Library'}`)}
          </button>
        ))}
      </div>

      <div
        id={`${tabsId}-panel-all`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-all`}
        hidden={tab !== 'all'}
        className={cn('flex flex-col gap-2', tab !== 'all' && 'hidden')}
      >
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex w-fit items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-foreground hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5" /> {t('settings.skillNew')}
          </button>
        )}
        {creating && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-black/20 p-2.5">
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.skillNamePlaceholder')}
            />
            <input
              className={inputCls}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.skillDescriptionPlaceholder')}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-white/5"
              >
                {t('settings.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void create()}
                disabled={!name.trim()}
                className="rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              >
                {t('settings.skillCreate')}
              </button>
            </div>
          </div>
        )}
        {state.skills.length === 0 && <p className="text-[11px] text-muted-foreground">{t('settings.skillsEmpty')}</p>}
        <p className="text-[11px] text-muted-foreground/70">{t('settings.skillsProjectHint')}</p>
        {state.skills.map((skill) => (
          <div key={skill.name} className="rounded-lg border border-border bg-white/[0.02] px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <Toggle
                on={skill.enabledGlobally}
                onClick={() =>
                  void window.api.chatSkillSetEnabled(skill.name, !skill.enabledGlobally).then(finishMutation)
                }
                label={skill.enabledGlobally ? t('settings.toggleOn') : t('settings.toggleOff')}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[12px] text-foreground">/{skill.name}</span>
                  <span className="rounded bg-white/[0.06] px-1 text-[10px] text-muted-foreground">
                    {t('settings.skillScopeGlobal')}
                  </span>
                  {!skill.userInvocable && (
                    <span className="rounded bg-white/[0.06] px-1 text-[10px] text-muted-foreground">
                      {t('settings.skillModelOnly')}
                    </span>
                  )}
                  {!skill.modelInvocable && (
                    <span className="rounded bg-white/[0.06] px-1 text-[10px] text-muted-foreground">
                      {t('settings.skillUserOnly')}
                    </span>
                  )}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{skill.description || skill.source}</div>
                <div className="text-[10px] text-muted-foreground/70">
                  {t('skillsMenu.resources', skill.resources)}
                  {skill.groupIds.length ? ` · ${t('settings.skillInGroups', { count: skill.groupIds.length })}` : ''}
                  {skill.installedFrom ? ` · ${t('settings.skillInstalledFrom', { slug: skill.installedFrom })}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSkillGroupPicker(skillGroupPicker === skill.name ? null : skill.name)}
                className="text-muted-foreground hover:text-violet-300"
                title={t('settings.skillGroupsAction')}
              >
                <Layers3 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void window.api.chatSkillRead(skill.name).then(setDetail)}
                className="text-muted-foreground hover:text-foreground"
                title={t('settings.skillView')}
              >
                <Eye className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void window.api.chatSkillReveal(skill.name)}
                className="text-muted-foreground hover:text-foreground"
                title={t('settings.skillOpenFolder')}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(t('settings.skillConfirmRemove', { name: skill.name, dir: skill.dir })))
                    void window.api.chatSkillRemove(skill.name).then(finishMutation)
                }}
                className="text-muted-foreground hover:text-destructive"
                title={t('settings.skillRemove')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {skillGroupPicker === skill.name && (
              <div className="mt-2 border-t border-border/60 pt-2">
                <div className="mb-1 text-[11px] text-muted-foreground">{t('settings.skillGroupsAction')}</div>
                {state.groups.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">{t('settings.skillGroupsEmpty')}</p>
                ) : (
                  state.groups.map((group) => (
                    <label
                      key={group.id}
                      className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-foreground"
                    >
                      <input
                        type="checkbox"
                        checked={group.skills.includes(skill.name)}
                        disabled={busyGroups.has(group.id)}
                        onChange={() => toggleMembership(group, skill.name)}
                      />
                      {group.name}
                    </label>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
        {detail && <SkillDetailPanel detail={detail} onClose={() => setDetail(null)} />}
      </div>

      <div
        id={`${tabsId}-panel-groups`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-groups`}
        hidden={tab !== 'groups'}
        className={cn('flex flex-col gap-2', tab !== 'groups' && 'hidden')}
      >
        {!creatingGroup && (
          <button
            type="button"
            onClick={() => setCreatingGroup(true)}
            className="inline-flex w-fit items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-foreground hover:bg-white/5"
          >
            <Plus className="h-3.5 w-3.5" /> {t('settings.skillGroupNew')}
          </button>
        )}
        {creatingGroup && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-black/20 p-2.5">
            <input
              className={inputCls}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={t('settings.skillGroupNamePlaceholder')}
            />
            <input
              className={inputCls}
              value={groupDescription}
              onChange={(e) => setGroupDescription(e.target.value)}
              placeholder={t('settings.skillGroupDescriptionPlaceholder')}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreatingGroup(false)}
                className="rounded-md border border-border px-2.5 py-1 text-[12px] text-muted-foreground"
              >
                {t('settings.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void createGroup()}
                disabled={!groupName.trim()}
                className="rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              >
                {t('settings.skillGroupCreate')}
              </button>
            </div>
          </div>
        )}
        {state.groups.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t('settings.skillGroupsEmpty')}</p>
        )}
        {state.groups.map((group) => {
          const open = openGroups.has(group.id)
          const available = group.skills.filter((name) => availableNames.has(name))
          const missing = group.skills.filter((name) => !availableNames.has(name))
          const editing = editingGroup?.id === group.id
          return (
            <div key={group.id} className="rounded-lg border border-border bg-white/[0.02]">
              <div className="flex items-center gap-2 px-2.5 py-2">
                <button
                  type="button"
                  onClick={() =>
                    setOpenGroups((current) => {
                      const next = new Set(current)
                      if (next.has(group.id)) next.delete(group.id)
                      else next.add(group.id)
                      return next
                    })
                  }
                  className="text-muted-foreground"
                >
                  {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-foreground">{group.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {group.description || t('settings.skillGroupCount', { count: group.skills.length })}
                  </div>
                </div>
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t('settings.skillGroupAvailableCount', { count: available.length })}
                  {missing.length ? ` · ${t('settings.skillGroupMissingCount', { count: missing.length })}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setEditingGroup({ id: group.id, name: group.name, description: group.description ?? '' })
                    setOpenGroups((current) => new Set(current).add(group.id))
                  }}
                  title={t('settings.skillGroupRename')}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => duplicateGroup(group)}
                  title={t('settings.skillGroupDuplicate')}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeGroup(group)}
                  title={t('settings.skillGroupRemove')}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              {open && (
                <div className="border-t border-border/60 px-3 py-2">
                  {editing && (
                    <div className="mb-2 flex flex-col gap-1.5 rounded-md bg-black/20 p-2">
                      <input
                        className={inputCls}
                        value={editingGroup.name}
                        onChange={(e) => setEditingGroup({ ...editingGroup, name: e.target.value })}
                      />
                      <input
                        className={inputCls}
                        value={editingGroup.description}
                        onChange={(e) => setEditingGroup({ ...editingGroup, description: e.target.value })}
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingGroup(null)}
                          className="text-[11px] text-muted-foreground"
                        >
                          {t('settings.cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void updateGroup(group, {
                              name: editingGroup.name,
                              description: editingGroup.description,
                            }).then((ok) => ok && setEditingGroup(null))
                          }
                          className="rounded bg-indigo-500 px-2 py-1 text-[11px] text-white"
                        >
                          {t('settings.save')}
                        </button>
                      </div>
                    </div>
                  )}
                  {available.map((name) => (
                    <div key={name} className="flex items-center gap-2 py-1 text-[12px]">
                      <span className="min-w-0 flex-1 truncate font-mono text-foreground">/{name}</span>
                      <button
                        type="button"
                        onClick={() => toggleMembership(group, name)}
                        className="text-muted-foreground hover:text-destructive"
                        title={t('settings.skillGroupRemoveSkill')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {missing.map((name) => (
                    <div key={name} className="flex items-center gap-2 py-1 text-[12px] opacity-55">
                      <span className="min-w-0 flex-1 truncate font-mono">/{name}</span>
                      <span className="text-[10px] text-muted-foreground">{t('settings.skillGroupMissing')}</span>
                      <button
                        type="button"
                        onClick={() => toggleMembership(group, name)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setMembershipEditor(membershipEditor === group.id ? null : group.id)
                      setMembershipQuery('')
                    }}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-violet-300 hover:text-violet-200"
                  >
                    <Plus className="h-3 w-3" /> {t('settings.skillGroupAddSkills')}
                  </button>
                  {membershipEditor === group.id && (
                    <div className="mt-2 rounded-md border border-border/60 bg-black/20 p-2">
                      <input
                        className={cn(inputCls, 'w-full')}
                        value={membershipQuery}
                        onChange={(e) => setMembershipQuery(e.target.value)}
                        placeholder={t('settings.skillGroupSearchSkills')}
                      />
                      <div className="mt-1 max-h-44 overflow-auto">
                        {state.skills
                          .filter(
                            (skill) =>
                              skill.name.includes(membershipQuery.trim().toLowerCase()) ||
                              skill.description.toLowerCase().includes(membershipQuery.trim().toLowerCase())
                          )
                          .map((skill) => (
                            <label key={skill.name} className="flex cursor-pointer items-center gap-2 py-1 text-[12px]">
                              <input
                                type="checkbox"
                                checked={group.skills.includes(skill.name)}
                                disabled={busyGroups.has(group.id)}
                                onChange={() => toggleMembership(group, skill.name)}
                              />
                              <span className="font-mono text-foreground">/{skill.name}</span>
                              <span className="min-w-0 truncate text-muted-foreground">{skill.description}</span>
                            </label>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div
        id={`${tabsId}-panel-library`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-tab-library`}
        hidden={tab !== 'library'}
        className={cn('flex flex-col gap-2', tab !== 'library' && 'hidden')}
      >
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
          <Sparkles className="h-3.5 w-3.5 text-violet-300" /> {t('settings.skillLibraryHeading')}
        </div>
        <div className="flex gap-1.5">
          <input
            className={cn(inputCls, 'min-w-0 flex-1')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (!e.target.value.trim()) {
                searchRequest.current += 1
                setSearching(false)
                setHits(null)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search()
            }}
            placeholder={t('settings.skillSearchPlaceholder')}
          />
          <button
            type="button"
            onClick={() => void search()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-foreground"
          >
            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            {searching ? t('settings.skillSearching') : t('settings.skillSearch')}
          </button>
        </div>
        {hits?.length === 0 && <p className="text-[11px] text-muted-foreground">{t('settings.skillNoResults')}</p>}
        {hits?.map((hit) => (
          <div key={hit.id} className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-foreground">{hit.name}</div>
              <div className="truncate text-[10px] text-muted-foreground">
                {hit.source} · {t('settings.skillInstalls', { count: hit.installs })}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void window.api.openExternalUrl(hit.url)}
              title={t('settings.skillOpenInBrowser')}
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void install(hit.slug, hit.installed)}
              disabled={busy === hit.slug}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-foreground disabled:opacity-60"
            >
              {busy === hit.slug ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
              {hit.installed ? t('settings.skillOverwrite') : t('settings.skillInstall')}
            </button>
          </div>
        ))}
        <div className="flex gap-1.5">
          <input
            className={cn(inputCls, 'min-w-0 flex-1')}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void install(slug, false)
            }}
            placeholder={t('settings.skillSlugPlaceholder')}
          />
          <button
            type="button"
            onClick={() => void install(slug, false)}
            disabled={!slug.trim() || busy === slug}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-foreground disabled:opacity-60"
          >
            {busy === slug ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t('settings.skillInstallBySlug')}
          </button>
        </div>
      </div>

      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
