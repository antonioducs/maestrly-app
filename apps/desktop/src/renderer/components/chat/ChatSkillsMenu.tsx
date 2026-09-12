import { OptionSelect, SelectOption } from '@/components/ui/option-select'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Layers3, RotateCcw, Settings2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  ChatSkillGroup,
  ChatSkillInfo,
  ChatSkillOverride,
  ChatSkillSelection,
  ChatSkillsState,
} from '../../../shared/chat'

const EMPTY_STATE: ChatSkillsState = {
  skills: [],
  groups: [],
  selection: { kind: 'all' },
  selectedGroupMissing: false,
  hasOverrides: false,
}

function SkillRow({
  skill,
  onSetOverride,
}: {
  skill: ChatSkillInfo
  onSetOverride: (name: string, state: ChatSkillOverride | 'inherit') => void
}) {
  const { t } = useTranslation('chat')
  const selected: ChatSkillOverride | 'inherit' = skill.override ?? 'inherit'
  return (
    <div className="rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">/{skill.name}</span>
        {!skill.enabledGlobally && (
          <span className="rounded bg-amber-500/10 px-1 text-[10px] text-amber-300">{t('skillsMenu.globallyOff')}</span>
        )}
        <span className="rounded bg-white/[0.06] px-1 text-[10px] text-muted-foreground">
          {skill.scope === 'project' ? t('settings.skillScopeProject') : t('settings.skillScopeGlobal')}
        </span>
      </div>
      {skill.description && <div className="truncate text-[11px] text-muted-foreground">{skill.description}</div>}
      <div className="mt-1 flex items-center gap-1">
        {(['inherit', 'on', 'off'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onSetOverride(skill.name, option)}
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px]',
              selected === option ? 'bg-white/[0.12] text-foreground' : 'text-muted-foreground hover:bg-white/[0.06]'
            )}
          >
            {t(`skillsMenu.${option}`)}
          </button>
        ))}
        {selected === 'inherit' && (
          <span className="ml-1 text-[10px] text-muted-foreground/70">
            {skill.baseEnabled ? t('skillsMenu.inheritedOn') : t('skillsMenu.inheritedOff')}
          </span>
        )}
      </div>
    </div>
  )
}

export function ChatSkillsMenu({ conversationId, onChanged }: { conversationId: string; onChanged?: () => void }) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ChatSkillsState>(EMPTY_STATE)
  const [mainOpen, setMainOpen] = useState(true)
  const [othersOpen, setOthersOpen] = useState(false)
  const [editGroups, setEditGroups] = useState(false)
  const [editingGroupId, setEditingGroupId] = useState('')
  const [groupQuery, setGroupQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const groupMutations = useRef(new Set<string>())
  const [busyGroups, setBusyGroups] = useState<Set<string>>(new Set())

  const load = (): Promise<void> =>
    window.api.chatSkillsState(conversationId).then((next) => {
      setState(next)
      setEditingGroupId((current) =>
        next.groups.some((group) => group.id === current) ? current : (next.groups[0]?.id ?? '')
      )
    })
  const changed = async (): Promise<void> => {
    await load()
    onChanged?.()
  }

  useEffect(() => {
    setOpen(false)
    setEditGroups(false)
    void load()
  }, [conversationId])

  useEffect(() => {
    const onSkillsChanged = () => void load()
    window.addEventListener('maestrly:skills-changed', onSkillsChanged)
    return () => window.removeEventListener('maestrly:skills-changed', onSkillsChanged)
  }, [conversationId])

  useEffect(() => {
    if (!open) return
    void load()
    const onDoc = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-select-content]')) return
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const setOverride = (name: string, override: ChatSkillOverride | 'inherit'): void => {
    void window.api.chatSkillSetOverride(conversationId, name, override).then(changed)
  }

  const setSelection = (selection: ChatSkillSelection): void => {
    void window.api.chatSkillSetSelection(conversationId, selection).then(changed)
  }

  const selectionValue = state.selection.kind === 'group' ? `group:${state.selection.groupId}` : state.selection.kind
  const selectedGroupId = state.selection.kind === 'group' ? state.selection.groupId : undefined
  const selectedGroup = selectedGroupId ? state.groups.find((group) => group.id === selectedGroupId) : undefined
  const mainSkills =
    state.selection.kind === 'all'
      ? state.skills
      : state.selection.kind === 'group'
        ? state.skills.filter((skill) => skill.inSelectedGroup)
        : []
  const mainNames = new Set(mainSkills.map((skill) => skill.name))
  const otherSkills = state.skills.filter((skill) => !mainNames.has(skill.name))
  const active = state.skills.filter((skill) => skill.enabled).length
  const activeLabel = state.selectedGroupMissing
    ? t('skillsMenu.deletedGroup')
    : state.selection.kind === 'all'
      ? t('skillsMenu.allSkills')
      : state.selection.kind === 'none'
        ? t('skillsMenu.noSkills')
        : (selectedGroup?.name ?? t('skillsMenu.noSkills'))
  const editingGroup = state.groups.find((group) => group.id === editingGroupId)
  const filteredSkills = state.skills.filter((skill) => {
    const query = groupQuery.trim().toLowerCase()
    return !query || skill.name.includes(query) || skill.description.toLowerCase().includes(query)
  })

  if (state.skills.length === 0 && state.groups.length === 0) return null

  const toggleGroupSkill = (group: ChatSkillGroup, skillName: string): void => {
    if (groupMutations.current.has(group.id)) return
    const skills = group.skills.includes(skillName)
      ? group.skills.filter((name) => name !== skillName)
      : [...group.skills, skillName]
    groupMutations.current.add(group.id)
    setBusyGroups((current) => new Set(current).add(group.id))
    void window.api
      .chatSkillGroupUpdate(group.id, { skills })
      .then(changed)
      .finally(() => {
        groupMutations.current.delete(group.id)
        setBusyGroups((current) => {
          const next = new Set(current)
          next.delete(group.id)
          return next
        })
      })
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={t('skillsMenu.button')}
        className={cn(
          'flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] text-muted-foreground hover:bg-white/[0.05] hover:text-foreground',
          active > 0 && 'text-violet-300'
        )}
      >
        <Sparkles className="h-3.5 w-3.5" />
        <span className="tabular-nums">{active}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('skillsMenu.heading')}
          className="absolute bottom-full left-0 z-50 mb-1 max-h-[28rem] w-96 overflow-auto rounded-lg border border-white/[0.1] bg-[#161618] p-1 shadow-2xl"
        >
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-foreground">{activeLabel}</div>
              <div className="text-[10px] text-muted-foreground">
                {t('skillsMenu.activeCount', { active, total: state.skills.length })}
                {state.hasOverrides ? ` · ${t('skillsMenu.customized')}` : ''}
              </div>
            </div>
            {state.hasOverrides && (
              <button
                type="button"
                onClick={() => void window.api.chatSkillResetOverrides(conversationId).then(changed)}
                title={t('skillsMenu.resetOverrides')}
                className="text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setEditGroups((value) => !value)}
              title={t('skillsMenu.editGroups')}
              className={cn('text-muted-foreground hover:text-foreground', editGroups && 'text-violet-300')}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          </div>

          {!editGroups ? (
            <>
              <div className="px-2 pb-1.5">
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t('skillsMenu.activeSet')}
                </label>
                <OptionSelect
                  value={selectionValue}
                  onValueChange={(selectedValue) => {
                    const value = selectedValue
                    if (value === 'all' || value === 'none') setSelection({ kind: value })
                    else setSelection({ kind: 'group', groupId: value.slice('group:'.length) })
                  }}
                  className="h-8 text-xs"
                >
                  <SelectOption value="all">{t('skillsMenu.allSkills')}</SelectOption>
                  <SelectOption value="none">{t('skillsMenu.noSkills')}</SelectOption>
                  {state.groups.map((group) => (
                    <SelectOption key={group.id} value={`group:${group.id}`}>
                      {group.name} ({group.skills.length})
                    </SelectOption>
                  ))}
                  {state.selectedGroupMissing && <SelectOption value={selectionValue}>{t('skillsMenu.deletedGroup')}</SelectOption>}
                </OptionSelect>
              </div>

              <button
                type="button"
                onClick={() => setMainOpen((value) => !value)}
                className="flex w-full items-center gap-1 border-t border-white/[0.06] px-2.5 py-1.5 text-left text-[11px] uppercase tracking-wide text-muted-foreground"
              >
                {mainOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {state.selection.kind === 'group' ? t('skillsMenu.groupSkills') : t('skillsMenu.selectedSkills')} ·{' '}
                {mainSkills.length}
              </button>
              {mainOpen &&
                mainSkills.map((skill) => <SkillRow key={skill.name} skill={skill} onSetOverride={setOverride} />)}
              {mainOpen && mainSkills.length === 0 && (
                <p className="px-2.5 py-2 text-[11px] text-muted-foreground">{t('skillsMenu.emptySelection')}</p>
              )}

              {otherSkills.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setOthersOpen((value) => !value)}
                    className="flex w-full items-center gap-1 border-t border-white/[0.06] px-2.5 py-1.5 text-left text-[11px] uppercase tracking-wide text-muted-foreground"
                  >
                    {othersOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {t('skillsMenu.otherSkills')} · {otherSkills.length}
                  </button>
                  {othersOpen &&
                    otherSkills.map((skill) => <SkillRow key={skill.name} skill={skill} onSetOverride={setOverride} />)}
                </>
              )}
            </>
          ) : (
            <div className="border-t border-white/[0.06] p-2">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                <Layers3 className="h-3.5 w-3.5 text-violet-300" /> {t('skillsMenu.editGroups')}
              </div>
              {state.groups.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('settings.skillGroupsEmpty')}</p>
              ) : (
                <>
                  <OptionSelect
                    value={editingGroupId}
                    onValueChange={(selectedValue) => setEditingGroupId(selectedValue)}
                    className="h-8 text-xs"
                  >
                    {state.groups.map((group) => (
                      <SelectOption key={group.id} value={group.id}>
                        {group.name}
                      </SelectOption>
                    ))}
                  </OptionSelect>
                  <input
                    value={groupQuery}
                    onChange={(event) => setGroupQuery(event.target.value)}
                    placeholder={t('settings.skillGroupSearchSkills')}
                    className="mt-2 w-full rounded-md border border-white/[0.1] bg-black/30 px-2 py-1.5 text-[12px] text-foreground outline-none"
                  />
                  <div className="mt-1 max-h-60 overflow-auto">
                    {editingGroup &&
                      filteredSkills.map((skill) => (
                        <label
                          key={skill.name}
                          className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12px] hover:bg-white/[0.04]"
                        >
                          <input
                            type="checkbox"
                            checked={editingGroup.skills.includes(skill.name)}
                            disabled={busyGroups.has(editingGroup.id)}
                            onChange={() => toggleGroupSkill(editingGroup, skill.name)}
                          />
                          <span className="font-mono text-foreground">/{skill.name}</span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">{skill.description}</span>
                          <span className="text-[10px] text-muted-foreground/70">
                            {skill.scope === 'project'
                              ? t('settings.skillScopeProject')
                              : t('settings.skillScopeGlobal')}
                          </span>
                        </label>
                      ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
