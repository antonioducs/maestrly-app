import type { FleetFileRef } from '@maestrly/bot-fleet-protocol'
import * as Sharing from 'expo-sharing'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Platform, View } from 'react-native'
import { fileKind, removedFileIds } from '../../fleet/bot-files'
import { formatBytes } from '../../fleet/format'
import { useFleet } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { fonts } from '../../theme/tokens'
import { Icon } from '../icons'
import { Button } from '../primitives/Button'
import { AppText } from '../primitives/Text'
import { fetchBotFile, FileIssue, type FileIssueKind } from './bot-file-fetch'
import { useConversation, type BotFileAccess } from './CueCard'

type Phase =
  | { phase: 'idle' }
  | { phase: 'downloading'; share: number | null }
  | { phase: 'playing'; uri: string }
  | { phase: 'failed'; issue: FileIssueKind }

/** A video downloaded to the phone, playing in the conversation with the system's controls and full screen. */
function InlineVideo({ uri, label }: { uri: string; label: string }) {
  const { palette } = useTheme()
  const player = useVideoPlayer(uri, (created) => {
    created.play()
  })
  return (
    <VideoView
      player={player}
      accessibilityLabel={label}
      nativeControls
      fullscreenOptions={{ enable: true }}
      contentFit="contain"
      style={{ width: '100%', aspectRatio: 16 / 9, borderRadius: 12, backgroundColor: palette.codeBg }}
    />
  )
}

/** A file the bot deleted: its card stays where it was shared and says so, with nothing left to open. */
function RemovedFileCard({ file }: { file: FleetFileRef }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const kind = fileKind(file, Platform.OS)
  return (
    <View
      style={{
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 16,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: palette.lineStrong,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <View
        aria-hidden
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: palette.surface,
        }}
      >
        <Icon name={kind === 'video' ? 'play' : kind === 'image' ? 'image' : 'file'} size={18} color={palette.faint} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText numberOfLines={2} tone="muted" style={{ fontSize: 15, lineHeight: 20, fontFamily: fonts.bodySemi }}>
          {file.name}
        </AppText>
        <AppText variant="small" tone="muted">
          {t('botFiles.removed', { size: formatBytes(file.byteSize) })}
        </AppText>
      </View>
    </View>
  )
}

function BotFileCard({ file }: { file: FleetFileRef }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const { files } = useConversation()
  const kind = fileKind(file, Platform.OS)
  const [state, setState] = useState<Phase>({ phase: 'idle' })
  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  async function open() {
    setState({ phase: 'downloading', share: null })
    const controller = new AbortController()
    abort.current = controller
    try {
      const saved = await fetchBotFile(files, file, {
        signal: controller.signal,
        onProgress: (share) => setState({ phase: 'downloading', share }),
      })
      if (kind === 'video') return setState({ phase: 'playing', uri: saved.uri })
      setState({ phase: 'idle' })
      await Sharing.shareAsync(saved.uri, { mimeType: file.mediaType, dialogTitle: file.name })
    } catch (error) {
      setState({ phase: 'failed', issue: error instanceof FileIssue ? error.issue : 'offline' })
    }
  }

  const downloading = state.phase === 'downloading'
  const progress = state.phase === 'downloading' && state.share !== null ? ` · ${Math.round(state.share * 100)}%` : ''
  return (
    <View
      style={{
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.raised,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          aria-hidden
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.surface,
          }}
        >
          <Icon
            name={kind === 'video' ? 'play' : kind === 'image' ? 'image' : 'file'}
            size={18}
            color={palette.muted}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText numberOfLines={2} style={{ fontSize: 15, lineHeight: 20, fontFamily: fonts.bodySemi }}>
            {file.name}
          </AppText>
          <AppText variant="small" tone="muted" accessibilityLiveRegion="polite">
            {downloading ? `${t('botFiles.downloading')}${progress}` : formatBytes(file.byteSize)}
          </AppText>
        </View>
        {state.phase === 'playing' ? null : downloading ? (
          <ActivityIndicator color={palette.muted} accessibilityLabel={t('botFiles.downloading')} />
        ) : (
          <Button
            label={kind === 'video' ? t('botFiles.play') : t('botFiles.download')}
            accessibilityLabel={t(kind === 'video' ? 'botFiles.playNamed' : 'botFiles.downloadNamed', {
              name: file.name,
            })}
            size="sm"
            variant="secondary"
            onPress={() => void open()}
          />
        )}
      </View>
      {state.phase === 'playing' ? <InlineVideo uri={state.uri} label={file.name} /> : null}
      {state.phase === 'failed' ? (
        <AppText
          accessibilityRole="alert"
          variant="small"
          style={{ color: state.issue === 'demo' ? palette.muted : palette.brick }}
        >
          {t(`botFiles.error.${state.issue}`)}
        </AppText>
      ) : null}
    </View>
  )
}

const NONE: ReadonlySet<string> = new Set()

function FileCards({ files, removed }: { files: FleetFileRef[]; removed: ReadonlySet<string> }) {
  return (
    <View style={{ gap: 8 }}>
      {files.map((file) =>
        removed.has(file.id) ? <RemovedFileCard key={file.id} file={file} /> : <BotFileCard key={file.id} file={file} />
      )}
    </View>
  )
}

/** A bot's conversation knows the files the bot deleted lately, once its Files sheet or conversation read them. */
function SharedFileCards({ files, access }: { files: FleetFileRef[]; access: BotFileAccess }) {
  const botId = access.botId
  const state = useFleet(useCallback((fleet: FleetState) => fleet.files[botId], [botId]))
  const removed = useMemo(() => removedFileIds(state), [state])
  return <FileCards files={files} removed={removed} />
}

/** The files a bot shared in a tool call: each video plays in the conversation, any other file opens to save. */
export function BotFiles({ files }: { files: FleetFileRef[] }) {
  const { files: access } = useConversation()
  return access ? <SharedFileCards files={files} access={access} /> : <FileCards files={files} removed={NONE} />
}
