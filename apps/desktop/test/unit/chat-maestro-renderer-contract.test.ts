import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Maestro renderer contract', () => {
  it('chooses the initial experience at creation and keeps Maestro separate from Standard ChatMode', () => {
    const dialog = readFileSync('src/renderer/components/NewConversationDialog.tsx', 'utf8')
    const picker = readFileSync('src/renderer/components/chat/ChatModePicker.tsx', 'utf8')
    expect(dialog).toContain("useState<ConversationExperience>('standard')")
    expect(dialog).toContain("setExperience('maestro')")
    expect(picker).not.toContain("id: 'maestro'")
  })

  it('offers Maestro from the Standard mode picker with the current model and strategy confirmation', () => {
    const view = readFileSync('src/renderer/components/chat/ChatView.tsx', 'utf8')
    const picker = readFileSync('src/renderer/components/chat/ChatModePicker.tsx', 'utf8')
    const preload = readFileSync('src/preload/api-chat.ts', 'utf8')
    expect(view).toContain('chatStandardConvertToMaestro(conversationId)')
    expect(view).toContain("setCurrentExperience('maestro')")
    expect(view).toContain('onUseMaestro={convertStandardToMaestro}')
    expect(picker).toContain("t('mode.useMaestro')")
    expect(picker).toContain('chatMaestroGetConversation(conversationId)')
    expect(picker).toContain("t('mode.confirmMaestro'")
    expect(preload).toContain("ipcRenderer.invoke('chat:standard:convert-to-maestro', conversationId)")
  })

  it('lets an idle Maestro conversation continue with its selected model while preserving the mounted chat', () => {
    const view = readFileSync('src/renderer/components/chat/ChatView.tsx', 'utf8')
    const control = readFileSync('src/renderer/components/chat/MaestroControl.tsx', 'utf8')
    const preload = readFileSync('src/preload/api-chat.ts', 'utf8')
    expect(view).toContain('chatMaestroConvertToStandard(conversationId)')
    expect(view).toContain("setCurrentExperience('standard')")
    expect(view).toContain('directModelId={selModelId}')
    expect(control).toContain("t('maestro.useDirectModel')")
    expect(control).toContain("'maestro.confirmDirectModel'")
    expect(preload).toContain("ipcRenderer.invoke('chat:maestro:convert-to-standard', conversationId)")
  })

  it('hides Standard mode UX, disables cycling, and renders the dedicated footer and persistent timeline', () => {
    const view = readFileSync('src/renderer/components/chat/ChatView.tsx', 'utf8')
    const control = readFileSync('src/renderer/components/chat/MaestroControl.tsx', 'utf8')
    const timeline = readFileSync('src/renderer/components/chat/OrchestrationRun.tsx', 'utf8')
    expect(view).toContain('onCycleMode={isMaestro ? undefined : cycleMode}')
    expect(view).toContain("if (isMaestro) {\n      setMode('agent')")
    expect(view).toContain('<MaestroControl')
    expect(control).toContain("t('maestro.chip'")
    expect(control).toContain("t('maestro.saveConversation')")
    expect(timeline).toContain("t('maestro.run.title')")
    expect(timeline).toContain("t('maestro.run.parentSelected')")
    expect(timeline).not.toContain('snapshot?.diversity')
  })

  it('keeps Send beside Stop and routes text to the active Maestro run with a durable fallback', () => {
    const view = readFileSync('src/renderer/components/chat/ChatView.tsx', 'utf8')
    const composer = readFileSync('src/renderer/components/chat/ChatComposer.tsx', 'utf8')
    const preload = readFileSync('src/preload/api-chat.ts', 'utf8')
    expect(composer).toContain('sendWhileStreaming')
    expect(composer).toContain('(!streaming || sendWhileStreaming)')
    expect(view).toContain('chatMaestroLivePost')
    expect(view).toContain("maestroSendTarget === 'current'")
    expect(view).toContain("t('composer.maestroTargetNext')")
    expect(view).toContain('maestroLive: { runId: result.run.id, messageId: result.message.id }')
    expect(preload).toContain("ipcRenderer.invoke('chat:maestro-live:post'")
    expect(preload).toContain('onChatMaestroLive')
  })

  it('localizes the Maestro panel and the orchestration timeline instead of hardcoding copy', () => {
    for (const file of [
      'src/renderer/components/chat/MaestroControl.tsx',
      'src/renderer/components/chat/OrchestrationRun.tsx',
    ]) {
      const source = readFileSync(file, 'utf8')
      expect(source, file).toContain("useTranslation('chat')")
      for (const hardcoded of ['Agent Pool', 'Save global default', 'Orchestration Run', 'Execution candidates']) {
        expect(source.includes(hardcoded), `${file} still hardcodes "${hardcoded}"`).toBe(false)
      }
    }
    const en = readFileSync('src/shared/i18n/en/chat.ts', 'utf8')
    const pt = readFileSync('src/shared/i18n/pt-BR/chat.ts', 'utf8')
    expect(en).toMatch(/(?:["']maestro["']|\bmaestro)\s*:\s*\{/)
    expect(pt).toMatch(/(?:["']maestro["']|\bmaestro)\s*:\s*\{/)
  })

  it('keeps subagent elapsed time across remounts and replaces the stale starting label', () => {
    const card = readFileSync('src/renderer/components/chat/SubagentCard.tsx', 'utf8')
    const display = readFileSync('src/renderer/lib/subagent-profile-display.ts', 'utf8')
    expect(card).toContain('useElapsed(running, observableSession?.startedAt ?? display.startedAt)')
    expect(card).toContain("t('subagent.preparingRuntime')")
    expect(card).toContain("t('subagent.modelStarted')")
    expect(display).toContain('meta?.startedAt')
    expect(display).toContain('meta?.maestro?.routedAt')
    expect(card).not.toContain("return 'starting…'")
  })

  it('edits Pool candidates through the shared provider/model/effort selectors, never raw text inputs', () => {
    const control = readFileSync('src/renderer/components/chat/MaestroControl.tsx', 'utf8')
    const fields = readFileSync('src/renderer/components/chat/subagent-profiles/CandidateFields.tsx', 'utf8')
    expect(control).toContain("import { CandidateFields } from './subagent-profiles/CandidateFields'")
    expect(control).toContain('<CandidateFields')
    expect(control).toContain('allowOff')
    // The panel must not rebuild provider/model/effort as free-text fields.
    expect(control).not.toContain('placeholder="provider"')
    expect(control).not.toContain('placeholder="model"')
    expect(fields).toContain('subagentProfileProviders')
    expect(fields).toContain('subagentProfileEffortIds')
    expect(fields).toContain('chatSubagentProfilesModelCatalog')
  })

  it('turns the Pool list into a drawer that collapses while a resource is open', () => {
    const control = readFileSync('src/renderer/components/chat/MaestroControl.tsx', 'utf8')
    const settings = readFileSync('src/renderer/components/chat/MaestroSettings.tsx', 'utf8')
    // A single column prevents the list and detail from competing for width.
    expect(control).not.toContain('grid-cols-[minmax(280px,360px)_minmax(0,1fr)]')
    expect(control).toContain("useState<'orchestrator' | number | null>(null)")
    expect(control).toContain('onSelect={() => setEditingTarget(index)}')
    expect(control).toContain("{t('maestro.backToPool')}")
    expect(control).toContain("onClick={() => setEditingTarget('orchestrator')}")
    expect(control).toContain('orchestratorSlot={orchestratorSlot}')
    expect(control).toContain('className="flex flex-col gap-1.5"')
    expect(control).not.toContain('xl:grid-cols-2')
    // Back/close restores the drawer; saving does the same through the host savedRevision.
    expect(control.match(/onClick=\{\(\) => setEditingTarget\(null\)\}/g)).toHaveLength(2)
    expect(control).toContain('if (savedRevision) setEditingTarget(null)')
    expect(control).toContain('savedRevision={savedRevision}')
    expect(settings).toContain('savedRevision={savedRevision}')
    expect(settings).toContain('setSavedRevision((revision) => revision + 1)')
  })

  it('renders the Maestro editor inside the chat area with an unsaved-changes guard', () => {
    const control = readFileSync('src/renderer/components/chat/MaestroControl.tsx', 'utf8')
    const view = readFileSync('src/renderer/components/chat/ChatView.tsx', 'utf8')
    expect(control).toContain('createPortal(')
    expect(control).toContain('absolute inset-0')
    expect(control).not.toContain('<Dialog')
    expect(control).not.toContain('absolute bottom-full')
    expect(view).toContain('id={maestroPanelHostId}')
    expect(view).toContain('panelHostId={maestroPanelHostId}')
    expect(control).toContain("t('maestro.confirmDiscard')")
    expect(control).toContain('triggerRef.current?.focus()')
    expect(control).toContain('idIssues')
  })

  it('uses the regular app typography instead of a dense 10px/11px modal scale', () => {
    const control = readFileSync('src/renderer/components/chat/MaestroControl.tsx', 'utf8')
    expect(control).toContain('text-base font-semibold')
    expect(control).toContain('text-sm font-medium')
    expect(control).not.toContain('text-[9px]')
    expect(control).not.toContain('text-[10px]')
  })

  it('places resource deletion beside duplication and confirms before removing', () => {
    const control = readFileSync('src/renderer/components/chat/MaestroControl.tsx', 'utf8')
    const copyButton = control.indexOf("title={t('maestro.duplicateResource')}")
    const deleteButton = control.indexOf("title={t('maestro.removeResource')}")
    expect(copyButton).toBeGreaterThan(-1)
    expect(deleteButton).toBeGreaterThan(copyButton)
    expect(deleteButton - copyButton).toBeLessThan(900)
    expect(control).toContain("window.confirm(t('maestro.confirmRemoveResource', { label: resource.label }))")
    expect(control).toContain('onRemove={value.pool.length > 1 ? () => removeResource(index) : undefined}')
  })

  it('marks Maestro conversations in the sidebar and shows a dedicated empty state', () => {
    const sidebar = readFileSync('src/renderer/components/sidebar/conv-rows.tsx', 'utf8')
    const messages = readFileSync('src/renderer/components/chat/ChatMessageList.tsx', 'utf8')
    expect(sidebar).toContain("conv.experience === 'maestro'")
    expect(messages).toContain('messages.maestroEmptyState')
  })

  it('adds a global Maestro editor as an accessible Maestrly Chat settings tab', () => {
    const settings = readFileSync('src/renderer/components/chat/ApiKeySettings.tsx', 'utf8')
    const maestroSettings = readFileSync('src/renderer/components/chat/MaestroSettings.tsx', 'utf8')
    const settingsView = readFileSync('src/renderer/components/SettingsView.tsx', 'utf8')
    expect(settings).toContain("'models' | 'maestro' | 'tools'")
    expect(settings).toContain("{ id: 'maestro', labelKey: 'settings.tabMaestro' }")
    expect(settings).toContain('id="chat-settings-panel-maestro"')
    expect(settings).toContain('aria-labelledby="chat-settings-tab-maestro"')
    expect(settings).toContain('<MaestroSettings config={config} />')
    expect(maestroSettings).toContain('chatMaestroGetGlobal()')
    expect(maestroSettings).toContain('chatMaestroSetGlobal(draft)')
    expect(maestroSettings).toContain('<MaestroConfigEditor')
    expect(maestroSettings).not.toContain('chatMaestroGetConversation')
    expect(maestroSettings).toContain('<OrchestratorProfileEditor')
    expect(maestroSettings).toContain("persistGlobal={selectedProfile?.source === 'global'}")
    expect(maestroSettings).toContain('chatMaestroStrategyProfilesCreate')
    expect(maestroSettings).toContain('chatMaestroStrategyProfilesUpdate')
    expect(maestroSettings).toContain('chatMaestroStrategyProfilesDelete')
    expect(maestroSettings).toContain('<SearchSelect')
    expect(maestroSettings).toContain('orchestrator: orchestratorDraft')
    expect(maestroSettings).toContain('config: draft')
    expect(maestroSettings).toContain('<FastModeChip')
    expect(maestroSettings).toContain('chatSetDefault(next)')
    expect(maestroSettings).toContain('chatSubagentProfilesModelMeta')
    expect(maestroSettings.match(/avoidOverflow/g)?.length).toBeGreaterThanOrEqual(2)
    expect(settingsView).toContain("section === 'chat' ? 'max-w-6xl' : 'max-w-2xl'")
  })

  it('shares the controlled Maestro editor between conversation and Settings hosts', () => {
    const control = readFileSync('src/renderer/components/chat/MaestroControl.tsx', 'utf8')
    const settings = readFileSync('src/renderer/components/chat/MaestroSettings.tsx', 'utf8')
    expect(control).toContain('export function MaestroConfigEditor({')
    expect(control.match(/<MaestroConfigEditor/g)).toHaveLength(1)
    expect(settings.match(/<MaestroConfigEditor/g)).toHaveLength(1)
    expect(control).toContain('subscribeMaestroConfigChanged')
    expect(settings).toContain('notifyMaestroConfigChanged()')
  })
})
