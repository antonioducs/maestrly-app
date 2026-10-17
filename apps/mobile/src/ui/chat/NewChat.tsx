import {
  MobileBridgeError,
  type MobileBranches,
  type MobileChatDefaults,
  type MobileConversation,
} from '@maestrly/bot-fleet-protocol'
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { AccessibilityInfo, Pressable, ScrollView, Switch, View } from 'react-native'
import { useChats, useChatsController } from '../../chats/react'
import { chatSetupSummary, optionFor } from '../../chats/selectors'
import type { ChatsState } from '../../chats/state'
import { useI18n } from '../../i18n'
import { useServers } from '../../servers/ServersProvider'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { clearDraft, ComposerShell, ShownError } from '../composer/Composer'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { branchChoice, EMPTY_BRANCH_DRAFT, type BranchDraft } from '../../chats/branch'
import { BranchChoice } from './BranchChoice'
import { ChatHostBanner } from './ChatHostBanner'

const SUGGESTIONS = [1, 2, 3] as const

/** The server's setup for new chats, in a pill that opens it. */
function DefaultsPill({ defaults }: { defaults: MobileChatDefaults | null }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const models = useChats(useCallback((state: ChatsState) => state.models, []))
  const option = optionFor(models?.options ?? [], defaults?.selection ?? null)
  const summary = defaults
    ? chatSetupSummary(
        {
          ...defaults,
          mode: 'agent',
          permMode: 'ask',
          experience: 'standard',
          ultra: 'maestrly',
          tools: { app: true, imageGen: true, subagents: true },
          contextLimit: null,
          mcp: [],
          skills: [],
        },
        option,
        null,
        t
      )
    : t('chat.setup.label')
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('chat.new.defaults', { summary })}
      onPress={() => router.push('/chat-defaults')}
      hitSlop={{ top: 5, bottom: 5 }}
      style={({ pressed }) => ({
        flexShrink: 1,
        minWidth: 0,
        height: 34,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginLeft: 2,
        paddingLeft: 11,
        paddingRight: 11,
        borderRadius: 17,
        backgroundColor: pressed ? palette.line : palette.surface,
      })}
    >
      <AppText
        numberOfLines={1}
        style={{ flexShrink: 1, fontFamily: fonts.bodyMedium, fontSize: 13.5, lineHeight: 18 }}
      >
        {summary}
      </AppText>
      {defaults?.fastMode ? <Icon name="zap-fill" size={14} color={palette.brass} /> : null}
    </Pressable>
  )
}

/**
 * A chat about to start: with no workspace it opens like a chat assistant, with a question and things to start with;
 * in a workspace it says where it runs. The first message creates the chat on the server, then goes as any other.
 */
export function NewChat({ workspaceId }: { workspaceId: string | null }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const chats = useChatsController()
  const { active, setCurrent } = useServers()
  const online = useChats(useCallback((state: ChatsState) => state.bridge === 'open', []))
  const workspace = useChats(
    useCallback(
      (state: ChatsState) => state.lists?.workspaces.find((item) => item.id === workspaceId) ?? null,
      [workspaceId]
    )
  )
  const [defaults, setDefaults] = useState<MobileChatDefaults | null>(null)
  const [maestro, setMaestro] = useState(false)
  // Null until the host lists them, and on hosts that predate the choice: the chat then gets a new branch of its own.
  const [branches, setBranches] = useState<MobileBranches | null>(null)
  const [branchDraft, setBranchDraft] = useState<BranchDraft>(EMPTY_BRANCH_DRAFT)
  const branch = branches ? branchChoice(branchDraft) : undefined
  const server = active?.name ?? ''
  const draftKey = `${active?.id ?? ''}:new:${workspaceId ?? ''}`

  useEffect(() => {
    if (!online) return
    void chats.defaults().then(setDefaults, () => {})
    void chats.loadModels().catch(() => {})
  }, [chats, online])

  useEffect(() => {
    setBranches(null)
    setBranchDraft(EMPTY_BRANCH_DRAFT)
    if (!online || !workspaceId) return
    let live = true
    void chats.branches(workspaceId).then(
      (value) => live && setBranches(value),
      () => {}
    )
    return () => {
      live = false
    }
  }, [chats, online, workspaceId])

  async function start(text: string, files: Parameters<typeof chats.send>[2]) {
    if (branch === null) throw new ShownError(t('branch.incomplete'))
    let conversation: MobileConversation
    try {
      conversation = await chats.create({
        workspaceId,
        ...(workspaceId && maestro ? { experience: 'maestro' as const } : {}),
        ...(workspaceId && branch ? { branch } : {}),
      })
    } catch (cause) {
      // The host's reason (a branch that exists, or is checked out elsewhere) says more than a failed send.
      if (branch && cause instanceof MobileBridgeError && cause.message) throw new ShownError(cause.message)
      throw cause
    }
    await chats.send(conversation.id, text, files)
    clearDraft(draftKey)
    setCurrent({ kind: 'chat', id: conversation.id })
    AccessibilityInfo.announceForAccessibility(t('announce.sent'))
  }

  return (
    <>
      <ChatHostBanner />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 24, gap: 10 }}
        keyboardShouldPersistTaps="handled"
      >
        {workspaceId ? (
          <View style={{ alignItems: 'center', gap: 8 }}>
            <View
              style={{
                width: 56,
                height: 56,
                borderRadius: 16,
                backgroundColor: palette.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="folder" size={26} color={palette.muted} />
            </View>
            <AppText variant="title" accessibilityRole="header" style={{ textAlign: 'center' }}>
              {t('chat.new.workspaceTitle', { name: workspace?.name ?? '' })}
            </AppText>
            <AppText tone="muted" style={{ textAlign: 'center' }}>
              {branches
                ? t('chat.new.workspaceBodyChoose', { server })
                : workspace?.defaultBranch
                  ? t('chat.new.workspaceBody', { server, branch: workspace.defaultBranch })
                  : t('chat.new.workspaceBodyNoBranch', { server })}
            </AppText>
            {branches ? <BranchChoice branches={branches} draft={branchDraft} onChange={setBranchDraft} /> : null}
            <View
              style={{
                alignSelf: 'stretch',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                marginTop: 12,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 14,
                backgroundColor: palette.surface,
              }}
            >
              <Icon name="sparkles" size={18} color={palette.brass} />
              <View style={{ flex: 1 }}>
                <AppText nativeID="maestro-label">{t('chat.new.maestro')}</AppText>
                <AppText variant="small" tone="muted">
                  {t('chat.new.maestroSub')}
                </AppText>
              </View>
              <Switch
                accessibilityLabel={t('chat.new.maestro')}
                value={maestro}
                onValueChange={setMaestro}
                trackColor={{ true: palette.brass, false: palette.lineStrong }}
              />
            </View>
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <AppText
              variant="title"
              accessibilityRole="header"
              style={{ textAlign: 'center', fontSize: 26, lineHeight: 31 }}
            >
              {t('chat.new.ask')}
            </AppText>
            <AppText tone="muted" style={{ textAlign: 'center', marginBottom: 12 }}>
              {t('chat.new.askBody', { server })}
            </AppText>
            {SUGGESTIONS.map((index) => (
              <Pressable
                key={index}
                accessibilityRole="button"
                disabled={!online}
                onPress={() => void start(t(`chat.suggest.${index}.text`), []).catch(() => {})}
                style={({ pressed }) => ({
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: palette.line,
                  backgroundColor: pressed ? palette.surface : palette.raised,
                  opacity: online ? 1 : 0.6,
                })}
              >
                <AppText style={{ fontFamily: fonts.bodySemi, fontSize: 15 }}>
                  {t(`chat.suggest.${index}.label`)}
                </AppText>
                <AppText variant="sub" tone="muted">
                  {t(`chat.suggest.${index}.text`)}
                </AppText>
              </Pressable>
            ))}
          </View>
        )}
        {online ? null : (
          <AppText variant="sub" tone="muted" style={{ textAlign: 'center', marginTop: 8 }}>
            {t('chat.new.offline', { server })}
          </AppText>
        )}
      </ScrollView>
      <ComposerShell
        key={draftKey}
        draftKey={draftKey}
        placeholder={workspace ? t('composer.placeholder', { name: workspace.name }) : t('chat.composer.ask')}
        filesEnabled
        setup={<DefaultsPill defaults={defaults} />}
        stopLabel={null}
        onStop={async () => {}}
        onSend={start}
        disabled={!online || branch === null}
      />
    </>
  )
}
